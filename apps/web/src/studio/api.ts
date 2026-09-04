import {
	apiFetch,
	uploadMedia,
	type ContentItem,
	type MediaItem as AdminMediaItem,
} from "@emdash-cms/admin";
import { filenameTitle } from "./domain";

export interface ContentEnvelope {
	item: ContentItem;
	_rev: string;
}

export interface ContentPage {
	items: ContentItem[];
	nextCursor?: string;
	total?: number;
}

export interface MediaUsageSummary {
	count: number | null;
	coverage: { status: string };
}

export interface StudioMediaItem extends AdminMediaItem {
	contentHash?: string | null;
	status?: string;
	usage?: MediaUsageSummary;
}

export interface MediaPage {
	items: StudioMediaItem[];
	nextCursor?: string;
}

type ApiEnvelope<T> = {
	success: boolean;
	data?: T;
	error?: { code?: string; message?: string; details?: unknown };
};

export class StudioApiError extends Error {
	code: string;
	status: number;
	details?: unknown;

	constructor(message: string, code = "STUDIO_API_ERROR", status = 500, details?: unknown) {
		super(message);
		this.name = "StudioApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
	if (!response.ok || !payload?.success || payload.data === undefined) {
		throw new StudioApiError(
			payload?.error?.message ?? `Request failed (${response.status})`,
			payload?.error?.code ?? "STUDIO_API_ERROR",
			response.status,
			payload?.error?.details,
		);
	}
	return payload.data;
}

export async function contentPage(
	collection: "photos" | "albums" | "posts" | "pages",
	options: {
		cursor?: string;
		limit?: number;
		search?: string;
		status?: string;
		orderBy?: string;
		order?: "asc" | "desc";
		fieldFilters?: Record<string, unknown>;
	} = {},
): Promise<ContentPage> {
	const params = new URLSearchParams();
	params.set("limit", String(options.limit ?? 100));
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.search) params.set("q", options.search);
	if (options.status) params.set("status", options.status);
	if (options.orderBy) params.set("orderBy", options.orderBy);
	if (options.order) params.set("order", options.order);
	if (options.fieldFilters) params.set("fieldFilters", JSON.stringify(options.fieldFilters));
	return unwrap<ContentPage>(await apiFetch(`/_emdash/api/content/${collection}?${params}`));
}

export async function allContent(
	collection: "photos" | "albums" | "posts" | "pages",
	options: Omit<Parameters<typeof contentPage>[1], "cursor"> = {},
): Promise<ContentItem[]> {
	const items: ContentItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await contentPage(collection, { ...options, cursor, limit: 100 });
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

export async function getContent(
	collection: "photos" | "albums" | "posts" | "pages",
	id: string,
): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}/${encodeURIComponent(id)}?locale=ja`));
}

export async function updateDraft(
	collection: "photos" | "albums" | "posts" | "pages",
	id: string,
	_rev: string,
	data: Record<string, unknown>,
): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}/${encodeURIComponent(id)}?locale=ja`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data, _rev }),
	}));
}

export async function publishDraft(collection: "photos" | "albums" | "posts" | "pages", id: string): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}/${encodeURIComponent(id)}/publish?locale=ja`, {
		method: "POST",
	}));
}

export async function createDraft(
	collection: "photos" | "albums" | "posts" | "pages",
	data: Record<string, unknown>,
	options: { bylines?: Array<{ bylineId: string; roleLabel?: string | null }> } = {},
): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data, status: "draft", locale: "ja", ...options }),
	}));
}

let kanoukBylinePromise: Promise<string> | null = null;

async function kanoukBylineId(): Promise<string> {
	kanoukBylinePromise ??= unwrap<{ items: Array<{ id: string; slug?: string; displayName?: string }> }>(
		await apiFetch("/_emdash/api/admin/bylines?limit=100"),
	).then(({ items }) => {
		const match = items.find((item) => item.slug === "kanouk") ?? items.find((item) => item.displayName === "カノ");
		if (!match) throw new StudioApiError("著者「カノ」が見つかりません。署名設定を確認してください。", "BYLINE_NOT_FOUND", 422);
		return match.id;
	});
	return kanoukBylinePromise;
}

export async function createArticleDraft(title: string): Promise<ContentEnvelope> {
	return createDraft("posts", {
		title,
		content: [],
		excerpt: "",
		published_on: new Date().toISOString(),
	}, { bylines: [{ bylineId: await kanoukBylineId() }] });
}

export async function mediaPage(options: { cursor?: string; search?: string } = {}): Promise<MediaPage> {
	const params = new URLSearchParams({ limit: "100", includeUsage: "1" });
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.search) params.set("q", options.search);
	return unwrap<MediaPage>(await apiFetch(`/_emdash/api/media?${params}`));
}

export async function allMedia(): Promise<StudioMediaItem[]> {
	const items: StudioMediaItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await mediaPage({ cursor });
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

export async function mediaUsage(id: string): Promise<{
	items: Array<{ collection: string; contentId: string; title: string | null; sources: Array<{ occurrences: Array<{ fieldPath: string }> }> }>;
	coverage: { status: string };
}> {
	return unwrap(await apiFetch(`/_emdash/api/media/${encodeURIComponent(id)}/usage?limit=100`));
}

export async function uploadPhoto(file: File, albumId: string, position: number): Promise<ContentEnvelope> {
	const media = await uploadMedia(file) as StudioMediaItem;
	return createPhotoFromMedia(media, albumId, position);
}

export async function createPhotoFromMedia(media: StudioMediaItem, albumId: string, position = 1024): Promise<ContentEnvelope> {
	const title = filenameTitle(media.filename);
	const image = {
		id: media.id,
		src: media.url,
		url: media.url,
		filename: media.filename,
		mimeType: media.mimeType,
		width: media.width,
		height: media.height,
		blurhash: media.blurhash,
		dominantColor: media.dominantColor,
		meta: media.storageKey ? { storageKey: media.storageKey } : undefined,
	};
	return createDraft("photos", {
		title,
		image,
		kind: media.mimeType.startsWith("video/") ? "video" : "image",
		alt: title,
		caption: "",
		album: albumId,
		position,
		source_system: "studio",
		source_id: media.id,
		original_sha256: media.contentHash ?? undefined,
		source_metadata: { studio_upload: true, uploaded_at: new Date().toISOString() },
	});
}

export async function recordOperation(input: {
	kind: string;
	status: string;
	targetIds: string[];
	failures?: Array<{ id: string; reason: string }>;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	await unwrap(await apiFetch("/_emdash/api/plugins/yohaku-photo-studio/operations", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "record", ...input }),
	}));
}

export async function issueHandoff(returnTo = "/albums"): Promise<string> {
	const response = await fetch("/studio/api/handoff", {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ returnTo }),
	});
	const payload = await response.json() as { success?: boolean; url?: string; error?: string };
	if (!response.ok || !payload.success || !payload.url) throw new Error(payload.error ?? "管理モードを開始できませんでした。");
	return payload.url;
}
