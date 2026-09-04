import type { APIRoute } from "astro";
import {
	isSameOriginMutation,
	readStudioSession,
	STUDIO_SESSION_COOKIE,
} from "../../../studio/session";
import { studioEnvironment } from "../../../studio/environment";

export const prerender = false;

const FIELDS: Record<string, ReadonlySet<string>> = {
	albums: new Set(["title", "description", "cover_image"]),
	photos: new Set(["title", "caption", "alt", "captured_at", "album", "position"]),
};
const CREATE_PHOTO_FIELDS = new Set([...FIELDS.photos, "image"]);

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Robots-Tag": "noindex, nofollow",
		},
	});
}

async function authorized(context: Parameters<APIRoute>[0]) {
	return readStudioSession(
		studioEnvironment(),
		context.cookies.get(STUDIO_SESSION_COOKIE)?.value,
	);
}

function failure(result: { error?: { code?: string; message?: string } }): Response {
	const code = result.error?.code ?? "STUDIO_ERROR";
	const status = code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : 400;
	return json({ success: false, error: { code, message: result.error?.message ?? "操作に失敗しました。" } }, status);
}

function allowedPatch(collection: string, value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const allowlist = FIELDS[collection];
	if (!allowlist) return null;
	const patch: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
		if (allowlist.has(key)) patch[key] = fieldValue;
	}
	return patch;
}

function allowedPhotoCreate(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const data = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => CREATE_PHOTO_FIELDS.has(key)));
	if (
		typeof data.title !== "string" || !data.title.trim() ||
		typeof data.album !== "string" || !data.album ||
		!data.image || typeof data.image !== "object" || Array.isArray(data.image) ||
		typeof (data.image as Record<string, unknown>).id !== "string"
	) return null;
	return data;
}

export const GET: APIRoute = async (context) => {
	if (!await authorized(context)) return json({ success: false }, 401);
	const { url, locals } = context;
	const collection = url.searchParams.get("collection") ?? "";
	if (!(collection in FIELDS) || !locals.emdash) return json({ success: false }, 400);
	const id = url.searchParams.get("id");
	if (id) {
		const result = await locals.emdash.handleContentGet(collection, id, "ja");
		return result.success ? json(result) : failure(result);
	}
	const albumId = url.searchParams.get("albumId");
	const result = await locals.emdash.handleContentList(collection, {
		limit: 100,
		cursor: url.searchParams.get("cursor") || undefined,
		locale: "ja",
		orderBy: collection === "photos" ? "position" : "updatedAt",
		order: collection === "photos" ? "asc" : "desc",
		fieldFilters: albumId && collection === "photos" ? { album: albumId } : undefined,
	});
	return result.success ? json(result) : failure(result);
};

export const PUT: APIRoute = async (context) => {
	if (!isSameOriginMutation(context.request)) return json({ success: false }, 403);
	if (!await authorized(context)) return json({ success: false }, 401);
	if (!context.locals.emdash) return json({ success: false }, 500);
	let body: { collection?: string; id?: string; _rev?: string; data?: unknown };
	try {
		body = await context.request.json() as typeof body;
	} catch {
		return json({ success: false }, 400);
	}
	const collection = body.collection ?? "";
	const patch = allowedPatch(collection, body.data);
	if (!body.id || !body._rev || !patch || Object.keys(patch).length === 0) {
		return json({ success: false, error: { code: "VALIDATION", message: "更新内容が不正です。" } }, 400);
	}
	const result = await context.locals.emdash.handleContentUpdate(collection, body.id, {
		data: patch,
		locale: "ja",
		_rev: body._rev,
	});
	return result.success ? json(result) : failure(result);
};

export const POST: APIRoute = async (context) => {
	if (!isSameOriginMutation(context.request)) return json({ success: false }, 403);
	const session = await authorized(context);
	if (!session) return json({ success: false }, 401);
	if (!context.locals.emdash) return json({ success: false }, 500);
	let body: { action?: string; collection?: string; id?: string; data?: unknown };
	try {
		body = await context.request.json() as typeof body;
	} catch {
		return json({ success: false }, 400);
	}
	const collection = body.collection ?? "";
	if (body.action === "create-photo" && collection === "photos") {
		const data = allowedPhotoCreate(body.data);
		if (!data) return json({ success: false }, 400);
		const result = await context.locals.emdash.handleContentCreate("photos", {
			data: {
				...data,
				kind: "image",
				source_system: "studio",
				source_id: String((data.image as Record<string, unknown>).id),
			},
			status: "draft",
			locale: "ja",
			authorId: session.userId,
		});
		return result.success ? json(result, 201) : failure(result);
	}
	if (body.action !== "publish" || !body.id || !(collection in FIELDS)) {
		return json({ success: false }, 400);
	}
	const result = await context.locals.emdash.handleContentPublish(collection, body.id);
	return result.success ? json(result) : failure(result);
};
