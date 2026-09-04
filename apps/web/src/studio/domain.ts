export type StudioContentData = Record<string, unknown>;

export type ReviewFlag =
	| "missing-caption"
	| "missing-alt"
	| "has-location"
	| "broken-media"
	| "unpublished";

export type BulkTextMode = "overwrite" | "prepend" | "append";

const LOCATION_KEYS = new Set([
	"gps",
	"gpslatitude",
	"gpslongitude",
	"gpsaltitude",
	"latitude",
	"longitude",
	"altitude",
	"location",
]);

export function textValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function mediaId(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const id = (value as Record<string, unknown>).id;
	return typeof id === "string" && id ? id : null;
}

export function mediaUrl(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const candidate of [record.src, record.url, record.previewUrl]) {
		if (typeof candidate === "string" && candidate) return candidate;
	}
	const storageKey =
		record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
			? (record.meta as Record<string, unknown>).storageKey
			: undefined;
	return typeof storageKey === "string" && storageKey
		? `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`
		: null;
}

export function mediaPreviewUrl(value: unknown, width: 320 | 480 | 768 = 320): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return mediaUrl(value);
	const record = value as Record<string, unknown>;
	const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
		? record.meta as Record<string, unknown>
		: {};
	const source = mediaUrl(value);
	const fileKey = source?.match(/^\/_emdash\/api\/media\/file\/([^/?#]+)$/)?.[1];
	const key = typeof meta.storageKey === "string" && meta.storageKey
		? meta.storageKey
		: fileKey
			? decodeURIComponent(fileKey)
			: null;
	return key ? `/_yohaku/media/preview-v2/${width}/webp/${encodeURIComponent(key)}` : source;
}

export function containsLocationMetadata(value: unknown, depth = 0): boolean {
	if (depth > 8 || value === null || value === undefined) return false;
	if (Array.isArray(value)) {
		return value.some((entry) => containsLocationMetadata(entry, depth + 1));
	}
	if (typeof value !== "object") return false;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, "");
		if (LOCATION_KEYS.has(normalized) && child !== null && child !== "" && child !== undefined) {
			return true;
		}
		if (containsLocationMetadata(child, depth + 1)) return true;
	}
	return false;
}

export function photoReviewFlags(
	data: StudioContentData,
	options: { status?: string; knownMediaIds?: ReadonlySet<string> } = {},
): ReviewFlag[] {
	const flags: ReviewFlag[] = [];
	if (!textValue(data.caption)) flags.push("missing-caption");
	if (!textValue(data.alt) && !textValue((data.image as Record<string, unknown> | undefined)?.alt)) {
		flags.push("missing-alt");
	}
	if (
		data.latitude !== null && data.latitude !== undefined ||
		data.longitude !== null && data.longitude !== undefined ||
		data.altitude !== null && data.altitude !== undefined ||
		containsLocationMetadata(data.source_metadata)
	) {
		flags.push("has-location");
	}
	const imageId = mediaId(data.image);
	if (options.knownMediaIds && (!imageId || !options.knownMediaIds.has(imageId))) {
		flags.push("broken-media");
	}
	if (options.status && options.status !== "published") flags.push("unpublished");
	return flags;
}

export function applyBulkText(
	current: unknown,
	value: string,
	mode: BulkTextMode,
): string {
	const existing = textValue(current);
	const next = value.trim();
	if (mode === "overwrite") return next;
	if (!next) return existing;
	if (!existing) return next;
	return mode === "prepend" ? `${next}${existing}` : `${existing}${next}`;
}

export function applyBulkPatch(
	data: StudioContentData,
	patch: {
		caption?: { value: string; mode: BulkTextMode };
		alt?: { value: string; mode: BulkTextMode };
		album?: string;
	},
): StudioContentData {
	const next = { ...data };
	if (patch.caption) next.caption = applyBulkText(data.caption, patch.caption.value, patch.caption.mode);
	if (patch.alt) next.alt = applyBulkText(data.alt, patch.alt.value, patch.alt.mode);
	if (patch.album !== undefined) next.album = patch.album;
	return next;
}

export function sparsePositions(count: number, step = 1024): number[] {
	return Array.from({ length: Math.max(0, count) }, (_, index) => (index + 1) * step);
}

export function duplicateGroups<T>(
	items: readonly T[],
	identity: (item: T) => string | null | undefined,
): T[][] {
	const grouped = new Map<string, T[]>();
	for (const item of items) {
		const key = identity(item)?.trim();
		if (!key) continue;
		const group = grouped.get(key) ?? [];
		group.push(item);
		grouped.set(key, group);
	}
	return [...grouped.values()].filter((group) => group.length > 1);
}

export function sanitizeReturnTo(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
		return "/albums";
	}
	try {
		const parsed = new URL(value, "https://photos.kanouk.com");
		return parsed.origin === "https://photos.kanouk.com"
			? `${parsed.pathname}${parsed.search}${parsed.hash}`
			: "/albums";
	} catch {
		return "/albums";
	}
}

export function filenameTitle(filename: string): string {
	return filename
		.replace(/\.[^.]+$/, "")
		.replaceAll(/[_-]+/g, " ")
		.trim() || "写真";
}
