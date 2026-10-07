import assert from "node:assert/strict";
import test from "node:test";

const { readPhotoMetadata } = await import("../src/studio/photo-metadata.ts");

/** A little-endian TIFF block with DateTimeOriginal, OffsetTimeOriginal and a GPS IFD. */
function tiff({ date = "2024:06:07 06:27:33", offset = "+09:00", gps = true } = {}) {
	const bytes = [];
	const u16 = (value) => bytes.push(value & 0xff, value >> 8);
	const u32 = (value) => bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
	const ascii = (text) => [...text].map((char) => char.charCodeAt(0)).concat(0);
	const ifd0 = 8;
	const ifd0Size = 2 + (gps ? 2 : 1) * 12 + 4;
	const exifIfd = ifd0 + ifd0Size;
	const exifSize = 2 + 2 * 12 + 4;
	const exifData = exifIfd + exifSize; // date (20 bytes), offset (7 bytes, inline would exceed 4)
	const gpsIfd = exifData + 20 + 7 + 1;
	const gpsSize = 2 + 6 * 12 + 4;
	const gpsData = gpsIfd + gpsSize;
	bytes.push(0x49, 0x49); u16(42); u32(ifd0);
	u16(gps ? 2 : 1);
	u16(0x8769); u16(4); u32(1); u32(exifIfd);
	if (gps) { u16(0x8825); u16(4); u32(1); u32(gpsIfd); }
	u32(0);
	u16(2);
	u16(0x9003); u16(2); u32(20); u32(exifData);
	u16(0x9011); u16(2); u32(7); u32(exifData + 20);
	u32(0);
	bytes.push(...ascii(date), ...ascii(offset), 0);
	if (gps) {
		u16(6);
		u16(1); u16(2); u32(2); bytes.push(...ascii("N"), 0, 0);
		u16(2); u16(5); u32(3); u32(gpsData);
		u16(3); u16(2); u32(2); bytes.push(...ascii("E"), 0, 0);
		u16(4); u16(5); u32(3); u32(gpsData + 24);
		u16(5); u16(1); u32(1); bytes.push(0, 0, 0, 0);
		u16(6); u16(5); u32(1); u32(gpsData + 48);
		u32(0);
		for (const [n, d] of [[35, 1], [39, 1], [2952, 100], [139, 1], [44, 1], [2808, 100], [405, 10]]) { u32(n); u32(d); }
	}
	return bytes;
}

function jpeg(tiffBytes) {
	const payload = [..."Exif\0\0"].map((char) => char.charCodeAt(0)).concat(tiffBytes);
	const length = payload.length + 2;
	return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

test("reads capture time with its recorded offset and the GPS position", () => {
	const metadata = readPhotoMetadata(jpeg(tiff()));
	assert.equal(metadata.readable, true);
	assert.equal(metadata.hasLocation, true);
	assert.equal(metadata.capturedAt, "2024-06-06T21:27:33.000Z");
	assert.equal(metadata.latitude, 35.6582);
	assert.equal(metadata.longitude, 139.7411333);
	assert.equal(metadata.altitude, 40.5);
});

test("a photo without GPS has a capture time and no location", () => {
	const metadata = readPhotoMetadata(jpeg(tiff({ gps: false })));
	assert.equal(metadata.hasLocation, false);
	assert.equal(metadata.latitude, undefined);
	assert.equal(metadata.capturedAt, "2024-06-06T21:27:33.000Z");
});

test("unknown containers are reported as unreadable, GIF as readable without metadata", () => {
	assert.deepEqual(readPhotoMetadata(new Uint8Array([1, 2, 3, 4])), { hasLocation: false, readable: false });
	assert.deepEqual(readPhotoMetadata(new TextEncoder().encode("GIF89a....")), { hasLocation: false, readable: true });
});

test("a JPEG without EXIF is readable and empty", () => {
	const metadata = readPhotoMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]));
	assert.deepEqual(metadata, { hasLocation: false, readable: true });
});
