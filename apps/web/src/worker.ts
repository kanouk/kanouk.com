import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const LEGACY_PREVIEW_PREFIX = "/_yohaku/media/preview-v1/";
const RESPONSIVE_PREVIEW_PREFIX = "/_yohaku/media/preview-v2/";
const EXTERNAL_PREVIEW_PREFIX = "/_yohaku/media/external-v1/";
const RESPONSIVE_WIDTHS = new Set([320, 480, 768, 1200, 1600]);
const ASTRO_STYLESHEET = /^\/_astro\/[^/]+\.css$/;
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
	const imageRequest = new Request(sourceUrl, {
		headers: { Accept: "image/*" },
	});
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

async function servePreview(
	request: HandlerRequest,
	env: HandlerEnv,
	context: HandlerContext,
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
		return new Response("Invalid media key", { status: 400 });
	}
	if (!mediaKey || mediaKey.includes("\0")) {
		return new Response("Invalid media key", { status: 400 });
	}

	const sourceUrl = new URL(
		`/_emdash/api/media/file/${encodeURIComponent(mediaKey)}`,
		url,
	);
	const transformed = await transformImage(request, sourceUrl, width, format, quality);
	if (!transformed) {
		return handler.fetch(
			new Request(sourceUrl, request) as HandlerRequest,
			env,
			context,
		);
	}

	return transformed;
}

export default {
	...handler,
	async fetch(request: HandlerRequest, env: HandlerEnv, context: HandlerContext) {
		const url = new URL(request.url);
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
				return transformed ?? Response.redirect(sourceUrl.toString(), 302);
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
