/**
 * Read the capture time and GPS position embedded in a photo, in the browser,
 * before upload. The file itself is uploaded unchanged. JPEG, PNG and WebP are
 * supported; GIF carries no camera metadata.
 */

export interface PhotoMetadata {
	/** ISO 8601 instant, when the file records one. */
	capturedAt?: string;
	latitude?: number;
	longitude?: number;
	altitude?: number;
	/** True when any GPS or XMP geotag data is present, even without usable coordinates. */
	hasLocation: boolean;
	/** False when the container could not be read, so the location state is unknown. */
	readable: boolean;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME = 0x0132;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const XMP_GEO = /GPS(?:Latitude|Longitude|Altitude)|geo:lat|geo:long|<exif:GPS/i;
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

class Tiff {
	readonly bytes: Uint8Array;
	readonly start: number;
	readonly end: number;
	readonly little: boolean;
	constructor(bytes: Uint8Array, start: number, end: number) {
		this.bytes = bytes;
		this.start = start;
		this.end = end;
		const order = String.fromCharCode(bytes[start], bytes[start + 1]);
		if (order !== "II" && order !== "MM") throw new Error("not a TIFF header");
		this.little = order === "II";
		if (this.u16(2) !== 42) throw new Error("not a TIFF header");
	}
	inRange(offset: number, length: number): boolean {
		return offset >= 0 && this.start + offset + length <= this.end;
	}
	u16(offset: number): number {
		const at = this.start + offset;
		return this.little ? this.bytes[at] | (this.bytes[at + 1] << 8) : (this.bytes[at] << 8) | this.bytes[at + 1];
	}
	u32(offset: number): number {
		const at = this.start + offset;
		const b = this.bytes;
		return (this.little
			? b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)
			: (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
	}
	entries(ifd: number): Array<{ at: number; tag: number; type: number; count: number; size: number; valueAt: number }> {
		if (!this.inRange(ifd, 2)) return [];
		const count = this.u16(ifd);
		if (!this.inRange(ifd + 2, count * 12 + 4)) return [];
		return Array.from({ length: count }, (_, index) => {
			const at = ifd + 2 + index * 12;
			const type = this.u16(at + 2);
			const count = this.u32(at + 4);
			const size = (TYPE_SIZES[type] ?? 1) * count;
			return { at, tag: this.u16(at), type, count, size, valueAt: size > 4 ? this.u32(at + 8) : at + 8 };
		});
	}
	ascii(entry: { valueAt: number; count: number }): string {
		if (!this.inRange(entry.valueAt, entry.count)) return "";
		const from = this.start + entry.valueAt;
		let text = "";
		for (let i = 0; i < entry.count && this.bytes[from + i] !== 0; i++) text += String.fromCharCode(this.bytes[from + i]);
		return text.trim();
	}
	rationals(entry: { valueAt: number; count: number }): number[] {
		if (!this.inRange(entry.valueAt, entry.count * 8)) return [];
		return Array.from({ length: entry.count }, (_, index) => {
			const denominator = this.u32(entry.valueAt + index * 8 + 4);
			return denominator ? this.u32(entry.valueAt + index * 8) / denominator : Number.NaN;
		});
	}
	ifd0(): number {
		return this.u32(4);
	}
}

function exifDate(value: string, offset: string): string | undefined {
	const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (!match || match[1] === "0000") return undefined;
	const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
	const zone = /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "";
	// Without a recorded offset the camera clock is read as this browser's local time,
	// the same rule the photo inspector uses for typed dates.
	const date = new Date(`${local}${zone}`);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function readTiff(tiff: Tiff, into: PhotoMetadata): void {
	let dateTime = "";
	let original = "";
	let offset = "";
	for (const entry of tiff.entries(tiff.ifd0())) {
		if (entry.tag === TAG_DATE_TIME) dateTime = tiff.ascii(entry);
		if (entry.tag === TAG_EXIF_IFD) {
			for (const exif of tiff.entries(tiff.u32(entry.at + 8))) {
				if (exif.tag === TAG_DATE_TIME_ORIGINAL) original = tiff.ascii(exif);
				if (exif.tag === TAG_OFFSET_TIME_ORIGINAL) offset = tiff.ascii(exif);
			}
		}
		if (entry.tag === TAG_GPS_IFD) {
			const gps = tiff.entries(tiff.u32(entry.at + 8));
			if (gps.length) into.hasLocation = true;
			const find = (tag: number) => gps.find((candidate) => candidate.tag === tag);
			const coordinate = (refTag: number, valueTag: number, negative: string) => {
				const value = find(valueTag);
				const ref = find(refTag);
				if (!value || value.type !== 5 || value.count < 3) return undefined;
				const [degrees, minutes, seconds] = tiff.rationals(value);
				const decimal = degrees + minutes / 60 + seconds / 3600;
				if (!Number.isFinite(decimal)) return undefined;
				return ref && tiff.ascii(ref).toUpperCase() === negative ? -decimal : decimal;
			};
			const latitude = coordinate(1, 2, "S");
			const longitude = coordinate(3, 4, "W");
			if (latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0)) {
				into.latitude = Math.round(latitude * 1e7) / 1e7;
				into.longitude = Math.round(longitude * 1e7) / 1e7;
				const altitude = find(6);
				const below = find(5);
				const [meters] = altitude && altitude.type === 5 ? tiff.rationals(altitude) : [];
				if (Number.isFinite(meters)) {
					const belowSea = below ? tiff.bytes[tiff.start + below.valueAt] === 1 : false;
					into.altitude = Math.round((belowSea ? -meters : meters) * 10) / 10;
				}
			}
		}
	}
	into.capturedAt ??= exifDate(original || dateTime, offset);
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
	for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
	return true;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
	let text = "";
	for (let i = from; i < to; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 0x8000)));
	return text;
}

type Segment = { marker: number; start: number; end: number; dataStart: number };

function jpegSegments(bytes: Uint8Array): Segment[] | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const segments: Segment[] = [];
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1];
		if (marker === 0xda || marker === 0xd9) break; // image data follows; metadata is over
		if (marker === 0xff) { at += 1; continue; }
		const length = (bytes[at + 2] << 8) | bytes[at + 3];
		if (length < 2 || at + 2 + length > bytes.length) return null;
		segments.push({ marker, start: at, end: at + 2 + length, dataStart: at + 4 });
		at += 2 + length;
	}
	return segments;
}

type Chunk = { type: string; start: number; end: number; dataStart: number; dataEnd: number };

function pngChunks(bytes: Uint8Array): Chunk[] | null {
	if (!startsWith(bytes, 1, "PNG")) return null;
	const chunks: Chunk[] = [];
	let at = 8;
	while (at + 12 <= bytes.length) {
		const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
		const type = latin1(bytes, at + 4, at + 8);
		const end = at + 12 + length;
		if (end > bytes.length) return null;
		chunks.push({ type, start: at, end, dataStart: at + 8, dataEnd: at + 8 + length });
		at = end;
		if (type === "IEND") break;
	}
	return chunks;
}

function webpChunks(bytes: Uint8Array): Chunk[] | null {
	if (!startsWith(bytes, 0, "RIFF") || !startsWith(bytes, 8, "WEBP")) return null;
	const chunks: Chunk[] = [];
	let at = 12;
	while (at + 8 <= bytes.length) {
		const length = (bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)) >>> 0;
		const end = at + 8 + length + (length % 2);
		if (at + 8 + length > bytes.length) return null;
		chunks.push({ type: latin1(bytes, at, at + 4), start: at, end: Math.min(end, bytes.length), dataStart: at + 8, dataEnd: at + 8 + length });
		at = end;
	}
	return chunks;
}

function tiffAt(bytes: Uint8Array, from: number, to: number): Tiff | null {
	try { return new Tiff(bytes, from, to); } catch { return null; }
}

export function readPhotoMetadata(input: Uint8Array): PhotoMetadata {
	const bytes = input;
	const result: PhotoMetadata = { hasLocation: false, readable: true };
	const jpeg = jpegSegments(bytes);
	if (jpeg) {
		for (const segment of jpeg) {
			if (segment.marker !== 0xe1) continue;
			if (startsWith(bytes, segment.dataStart, "Exif\0\0")) {
				const tiff = tiffAt(bytes, segment.dataStart + 6, segment.end);
				if (tiff) readTiff(tiff, result);
				else result.readable = false;
			} else if (startsWith(bytes, segment.dataStart, XMP_HEADER) && XMP_GEO.test(latin1(bytes, segment.dataStart, segment.end))) {
				result.hasLocation = true;
			}
		}
		return result;
	}
	const png = pngChunks(bytes);
	if (png) {
		for (const chunk of png) {
			if (chunk.type === "eXIf") {
				const tiff = tiffAt(bytes, chunk.dataStart, chunk.dataEnd);
				if (tiff) readTiff(tiff, result);
				else result.readable = false;
			}
			if (chunk.type === "iTXt" && XMP_GEO.test(latin1(bytes, chunk.dataStart, chunk.dataEnd))) result.hasLocation = true;
		}
		return result;
	}
	const webp = webpChunks(bytes);
	if (webp) {
		for (const chunk of webp) {
			if (chunk.type === "EXIF") {
				const skip = startsWith(bytes, chunk.dataStart, "Exif\0\0") ? 6 : 0;
				const tiff = tiffAt(bytes, chunk.dataStart + skip, chunk.dataEnd);
				if (tiff) readTiff(tiff, result);
				else result.readable = false;
			}
			if (chunk.type === "XMP " && XMP_GEO.test(latin1(bytes, chunk.dataStart, chunk.dataEnd))) result.hasLocation = true;
		}
		return result;
	}
	if (startsWith(bytes, 0, "GIF8")) return result;
	return { hasLocation: false, readable: false };
}
