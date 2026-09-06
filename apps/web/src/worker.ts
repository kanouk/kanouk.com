import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { needsLocationReview } from "./studio/domain";
import {
	addPrivateMediaHeaders,
	applyMediaAccessHeaders,
	authenticationHeaders,
	classifyMediaRead,
	deniedMediaResponse,
	mediaPreviewDelivery,
	publicMediaTransformationRequest,
	type PublicMediaDatabase,
	verifyAuthenticatedMediaRead,
} from "./studio/public-media-guard";

export { PluginBridge };

const LEGACY_PREVIEW_PREFIX = "/_yohaku/media/preview-v1/";
const RESPONSIVE_PREVIEW_PREFIX = "/_yohaku/media/preview-v2/";
const EXTERNAL_PREVIEW_PREFIX = "/_yohaku/media/external-v1/";
const RESPONSIVE_WIDTHS = new Set([320, 480, 768, 1200, 1600]);
const ASTRO_STYLESHEET = /^\/_astro\/[^/]+\.css$/;
const PHOTO_PUBLISH_ROUTE = /^\/_emdash\/api\/content\/photos\/([^/]+)\/(?:publish|schedule)$/;
type HandlerFetch = typeof handler.fetch;
type HandlerRequest = Parameters<HandlerFetch>[0];
type HandlerEnv = Parameters<HandlerFetch>[1];
type HandlerContext = Parameters<HandlerFetch>[2];
type ImageTransformInit = RequestInit & {
	cf: {
		image: {
			width: number;
			fit: "scale-down";
			format: "avif" | "webp";
			quality: number;
		};
	};
};

function isTrustedLegacyImageUrl(url: URL) {
	return url.protocol === "https:" && (
		url.hostname === "kanolog.net" ||
		url.hostname.endsWith(".kanolog.net") ||
		url.hostname === "nocalog.jp" ||
		url.hostname.endsWith(".nocalog.jp")
	);
}

async function transformImage(
	request: HandlerRequest,
	sourceUrl: URL,
	width: number,
	format: "avif" | "webp",
	quality: number,
) {
	const imageRequest = publicMediaTransformationRequest(sourceUrl);
	const transformOptions: ImageTransformInit = {
		cf: {
			image: {
				width,
				fit: "scale-down",
				format,
				quality,
			},
		},
	};
	const transformed = await fetch(imageRequest, transformOptions);
	if (!transformed.ok) return null;

	const headers = new Headers(transformed.headers);
	headers.set("Cache-Control", "public, max-age=31536000, immutable");
	return new Response(request.method === "HEAD" ? null : transformed.body, {
		status: transformed.status,
		headers,
	});
}

function authenticateMediaRequest(
	request: Request,
	env: HandlerEnv,
	context: HandlerContext,
): Promise<boolean> {
	return verifyAuthenticatedMediaRead(request, (probe) =>
		handler.fetch(probe as HandlerRequest, env, context));
}

async function servePreview(
	request: HandlerRequest,
	env: HandlerEnv,
	context: HandlerContext,
	database: PublicMediaDatabase,
	url: URL,
	encodedKey: string,
	width: number,
	format: "avif" | "webp",
	quality: number,
) {
	let mediaKey: string;
	try {
		mediaKey = decodeURIComponent(encodedKey);
	} catch {
		return deniedMediaResponse();
	}
	if (!mediaKey || mediaKey.includes("\0") || mediaKey.startsWith("backups/")) {
		return deniedMediaResponse();
	}

	const sourceUrl = new URL(
		`/_emdash/api/media/file/${encodeURIComponent(mediaKey)}`,
		url,
	);
	const sourceRequest = new Request(sourceUrl, {
		method: request.method,
		headers: authenticationHeaders(request),
	});
	const classification = await classifyMediaRead(sourceRequest, database, {
		authenticate: (candidate) => authenticateMediaRequest(candidate, env, context),
	});
	const delivery = mediaPreviewDelivery(classification.access);
	if (delivery === "deny") {
		return deniedMediaResponse();
	}
	if (delivery === "direct-private") {
		const response = await handler.fetch(sourceRequest as HandlerRequest, env, context);
		return applyMediaAccessHeaders(response, "authenticated");
	}
	const transformed = await transformImage(
		request,
		sourceUrl,
		width,
		format,
		quality,
	);
	if (!transformed) {
		return addPrivateMediaHeaders(new Response("Image preview is temporarily unavailable", {
			status: 502,
		}));
	}

	return transformed;
}

async function blockUnreviewedPhotoPublish(
	request: HandlerRequest,
	env: HandlerEnv,
	context: HandlerContext,
	url: URL,
): Promise<Response | null> {
	if (request.method !== "POST" || !PHOTO_PUBLISH_ROUTE.test(url.pathname)) return null;
	const match = url.pathname.match(PHOTO_PUBLISH_ROUTE);
	if (!match) return null;
	const readUrl = new URL(`/_emdash/api/content/photos/${match[1]}`, url);
	readUrl.searchParams.set("locale", url.searchParams.get("locale") ?? "ja");
	const readResponse = await handler.fetch(new Request(readUrl, {
		method: "GET",
		headers: request.headers,
	}) as HandlerRequest, env, context);
	if (!readResponse.ok) return readResponse;
	const payload = await readResponse.json().catch(() => null) as {
		data?: { item?: { data?: unknown } };
	} | null;
	if (!needsLocationReview(payload?.data?.item?.data)) return null;
	return Response.json({
		success: false,
		error: {
			code: "LOCATION_REVIEW_REQUIRED",
			message: "原本の位置情報を確認・除去するまで公開または公開予約できません。",
		},
	}, {
		status: 409,
		headers: { "Cache-Control": "private, no-store" },
	});
}

export default {
	...handler,
	async fetch(request: HandlerRequest, env: HandlerEnv, context: HandlerContext) {
		const url = new URL(request.url);
		const database = (env as HandlerEnv & { DB: PublicMediaDatabase }).DB;
		const originalAccess = await classifyMediaRead(
			request,
			database,
			{ authenticate: (candidate) => authenticateMediaRequest(candidate, env, context) },
		);
		if (originalAccess.access === "denied") return deniedMediaResponse();
		if (originalAccess.access === "public" || originalAccess.access === "authenticated") {
			const response = await handler.fetch(request, env, context);
			return applyMediaAccessHeaders(response, originalAccess.access);
		}
		const blockedPublish = await blockUnreviewedPhotoPublish(request, env, context, url);
		if (blockedPublish) return blockedPublish;
		if (
			(request.method === "GET" || request.method === "HEAD") &&
			ASTRO_STYLESHEET.test(url.pathname)
		) {
			const assets = (env as HandlerEnv & {
				ASSETS?: { fetch(input: Request): Promise<Response> };
			}).ASSETS;
			if (assets) return assets.fetch(request);
		}
		if (request.method === "GET" || request.method === "HEAD") {
			if (url.pathname.startsWith(EXTERNAL_PREVIEW_PREFIX)) {
				const match = url.pathname
					.slice(EXTERNAL_PREVIEW_PREFIX.length)
					.match(/^(\d+)\/(avif|webp)\/(.+)$/);
				if (!match) return new Response("Invalid image variant", { status: 400 });
				const width = Number(match[1]);
				const format = match[2] as "avif" | "webp";
				if (!RESPONSIVE_WIDTHS.has(width)) {
					return new Response("Unsupported image width", { status: 400 });
				}
				let sourceUrl: URL;
				try {
					sourceUrl = new URL(decodeURIComponent(match[3]));
				} catch {
					return new Response("Invalid external image URL", { status: 400 });
				}
				if (!isTrustedLegacyImageUrl(sourceUrl)) {
					return new Response("External image host is not allowed", { status: 403 });
				}
					const transformed = await transformImage(
					request,
					sourceUrl,
					width,
					format,
					format === "avif" ? 62 : 78,
				);
					return transformed ?? new Response("Image preview is temporarily unavailable", {
						status: 502,
						headers: { "Cache-Control": "private, no-store" },
					});
			}
			if (url.pathname.startsWith(RESPONSIVE_PREVIEW_PREFIX)) {
				const match = url.pathname
					.slice(RESPONSIVE_PREVIEW_PREFIX.length)
					.match(/^(\d+)\/(avif|webp)\/(.+)$/);
				if (!match) return new Response("Invalid image variant", { status: 400 });
				const width = Number(match[1]);
				const format = match[2] as "avif" | "webp";
				if (!RESPONSIVE_WIDTHS.has(width)) {
					return new Response("Unsupported image width", { status: 400 });
				}
					return servePreview(
						request,
						env,
						context,
						database,
						url,
					match[3],
					width,
					format,
					format === "avif" ? 62 : 78,
				);
			}
			if (url.pathname.startsWith(LEGACY_PREVIEW_PREFIX)) {
					return servePreview(
						request,
						env,
						context,
						database,
						url,
					url.pathname.slice(LEGACY_PREVIEW_PREFIX.length),
					1200,
					"webp",
					85,
				);
			}
		}

		return handler.fetch(request, env, context);
	},
	scheduled: createScheduledHandler(),
};
