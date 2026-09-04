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

interface PhotoMediaItem extends AdminMediaItem {
	contentHash?: string | null;
}

type ApiEnvelope<T> = {
	success: boolean;
	data?: T;
	error?: { code?: string; message?: string; details?: unknown };
};

export class PhotoToolsApiError extends Error {
	code: string;
	status: number;
	details?: unknown;

	constructor(message: string, code = "PHOTO_TOOLS_API_ERROR", status = 500, details?: unknown) {
		super(message);
		this.name = "PhotoToolsApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
	if (!response.ok || !payload?.success || payload.data === undefined) {
		throw new PhotoToolsApiError(
			payload?.error?.message ?? `Request failed (${response.status})`,
			payload?.error?.code ?? "PHOTO_TOOLS_API_ERROR",
			response.status,
			payload?.error?.details,
		);
	}
	return payload.data;
}

export async function contentPage(
	collection: "photos" | "albums",
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
	collection: "photos" | "albums",
	options: Omit<Parameters<typeof contentPage>[1], "cursor"> = {},
	onProgress?: (items: readonly ContentItem[]) => void,
): Promise<ContentItem[]> {
	const items: ContentItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await contentPage(collection, { ...options, cursor, limit: 100 });
		items.push(...page.items);
		onProgress?.([...items]);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

export async function getContent(collection: "photos" | "albums", id: string): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}/${encodeURIComponent(id)}?locale=ja`));
}

export async function updateDraft(
	collection: "photos" | "albums",
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

export async function publishDraft(collection: "photos" | "albums", id: string): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}/${encodeURIComponent(id)}/publish?locale=ja`, { method: "POST" }));
}

async function createDraft(collection: "photos" | "albums", data: Record<string, unknown>): Promise<ContentEnvelope> {
	return unwrap<ContentEnvelope>(await apiFetch(`/_emdash/api/content/${collection}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data, status: "draft", locale: "ja" }),
	}));
}

export function createAlbumDraft(title: string): Promise<ContentEnvelope> {
	return createDraft("albums", {
		title,
		description: "",
		sort_method: "position",
		sort_direction: "asc",
		allow_downloads: false,
		source_metadata: { photo_organizer_created: true },
	});
}

export async function uploadPhoto(file: File, albumId: string, position: number): Promise<ContentEnvelope> {
	const media = await uploadMedia(file) as PhotoMediaItem;
	const title = filenameTitle(media.filename);
	return createDraft("photos", {
		title,
		image: {
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
		},
		kind: media.mimeType.startsWith("video/") ? "video" : "image",
		alt: title,
		caption: "",
		album: albumId,
		position,
		source_system: "photo-organizer",
		source_id: media.id,
		source_metadata: {
			photo_organizer_upload: true,
			uploaded_at: new Date().toISOString(),
			location_review: "unreviewed",
			...(media.contentHash ? { content_hash: media.contentHash } : {}),
		},
	});
}

export async function recordOperation(input: {
	kind: string;
	status: string;
	targetIds: string[];
	failures?: Array<{ id: string; reason: string }>;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	await unwrap(await apiFetch("/_emdash/api/plugins/yohaku-photo-tools/operations", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "record", ...input }),
	}));
}
