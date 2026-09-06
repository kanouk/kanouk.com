export const PUBLIC_IMAGE_WIDTHS = [320, 480, 768, 1200, 1600] as const;

export type PublicImageWidth = typeof PUBLIC_IMAGE_WIDTHS[number];

export type UploadStage =
	| "queued"
	| "uploading-media"
	| "media-ready"
	| "creating-photo"
	| "photo-created"
	| "failed-validation"
	| "failed-media"
	| "failed-photo";

export interface UploadFileLike {
	name: string;
	type: string;
	size: number;
	lastModified?: number;
}

export interface UploadQueueItem<TFile extends UploadFileLike = UploadFileLike, TMedia = unknown> {
	id: string;
	file: TFile;
	position: number;
	stage: UploadStage;
	media?: TMedia;
	photoId?: string;
	error?: string;
}

export function createUploadQueue<TFile extends UploadFileLike, TMedia = unknown>(
	files: readonly TFile[],
	options: {
		batchId: string;
		startPosition: number;
		positionStep?: number;
		acceptedTypes: ReadonlySet<string>;
		maxBytes: number;
		maxFiles: number;
	},
): UploadQueueItem<TFile, TMedia>[] {
	const step = options.positionStep ?? 1024;
	return files.map((file, index) => {
		let stage: UploadStage = "queued";
		let error: string | undefined;
		if (index >= options.maxFiles) {
			stage = "failed-validation";
			error = `一度に追加できるのは${options.maxFiles}枚までです`;
		} else if (!options.acceptedTypes.has(file.type)) {
			stage = "failed-validation";
			error = "JPEG、PNG、WebP、GIFだけ追加できます";
		} else if (file.size > options.maxBytes) {
			stage = "failed-validation";
			error = "1枚50MBの上限を超えています";
		}
		return {
			id: `${options.batchId}:${index}:${file.name}:${file.size}:${file.lastModified ?? 0}`,
			file,
			position: options.startPosition + ((index + 1) * step),
			stage,
			...(error ? { error } : {}),
		};
	});
}

export function updateUploadQueueItem<TFile extends UploadFileLike, TMedia>(
	queue: readonly UploadQueueItem<TFile, TMedia>[],
	id: string,
	patch: Partial<Omit<UploadQueueItem<TFile, TMedia>, "id" | "file" | "position">>,
): UploadQueueItem<TFile, TMedia>[] {
	return queue.map((item) => item.id === id ? { ...item, ...patch } : item);
}

export function retryFailedUploadQueue<TFile extends UploadFileLike, TMedia>(
	queue: readonly UploadQueueItem<TFile, TMedia>[],
): UploadQueueItem<TFile, TMedia>[] {
	return queue.map((item) => {
		if (item.stage === "failed-media") {
			return { ...item, stage: "queued", error: undefined };
		}
		if (item.stage === "failed-photo" && item.media) {
			return { ...item, stage: "media-ready", error: undefined };
		}
		return item;
	});
}

export function isUploadQueueSettled(stage: UploadStage): boolean {
	return stage === "photo-created" || stage.startsWith("failed-");
}

export function isUploadQueueRetryable(stage: UploadStage): boolean {
	return stage === "failed-media" || stage === "failed-photo";
}

export function adjacentPhotoId(
	orderedIds: readonly string[],
	currentId: string,
	direction: -1 | 1,
): string | null {
	const index = orderedIds.indexOf(currentId);
	if (index < 0) return null;
	return orderedIds[index + direction] ?? null;
}

export function captionSelectionAfterSave(
	currentId: string,
	targetId: string | null,
	saved: boolean,
): string {
	return saved && targetId ? targetId : currentId;
}

export interface PhotoInspectorDraft {
	title: string;
	caption: string;
	alt: string;
	captured_at: string;
	album: string;
}

export interface PreparedPhotoDraft {
	patch: Record<string, unknown>;
	dateError?: string;
}

/** Convert a stored instant to the wall-clock value expected by datetime-local. */
export function dateTimeLocalInputValue(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
	return local.toISOString().slice(0, 16);
}

/**
 * Keep an untouched stored datetime byte-for-byte by omitting it from the patch.
 * An intentional clear becomes null; an edited datetime-local value becomes ISO.
 */
export function preparePhotoDraftPatch(
	originalCapturedAt: unknown,
	draft: PhotoInspectorDraft,
): PreparedPhotoDraft {
	const { captured_at: capturedAtInput, ...patch } = draft;
	const originalInput = dateTimeLocalInputValue(originalCapturedAt);
	if (capturedAtInput === originalInput) return { patch };
	if (!capturedAtInput) return { patch: { ...patch, captured_at: null } };
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(capturedAtInput)) {
		return { patch, dateError: "撮影日の形式を確認してください。" };
	}
	const parsed = new Date(capturedAtInput);
	if (!Number.isFinite(parsed.getTime())) {
		return { patch, dateError: "撮影日の形式を確認してください。" };
	}
	const iso = parsed.toISOString();
	if (dateTimeLocalInputValue(iso) !== capturedAtInput.slice(0, 16)) {
		return { patch, dateError: "実在する撮影日時を入力してください。" };
	}
	return { patch: { ...patch, captured_at: iso } };
}

export function canCopyPublishedImageVariants(item: {
	status?: string;
	draftRevisionId?: string | null;
	liveRevisionId?: string | null;
}): boolean {
	return item.status === "published" && !(
		item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId
	);
}

function storageKeyOf(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
		? record.meta as Record<string, unknown>
		: {};
	if (typeof meta.storageKey === "string" && meta.storageKey) return meta.storageKey;
	const source = [record.src, record.url].find((candidate) => typeof candidate === "string" && candidate) as string | undefined;
	const encoded = source?.match(/^\/_emdash\/api\/media\/file\/([^/?#]+)$/)?.[1];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

export function publicImageVariantPath(value: unknown, width: PublicImageWidth): string | null {
	if (!PUBLIC_IMAGE_WIDTHS.includes(width)) return null;
	const storageKey = storageKeyOf(value);
	return storageKey
		? `/_yohaku/media/preview-v2/${width}/webp/${encodeURIComponent(storageKey)}`
		: null;
}
