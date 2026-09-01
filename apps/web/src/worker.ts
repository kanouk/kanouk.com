import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const PREVIEW_PREFIX = "/_yohaku/media/preview-v1/";
const PREVIEW_WIDTH = 1200;
type HandlerFetch = typeof handler.fetch;
type HandlerRequest = Parameters<HandlerFetch>[0];
type HandlerEnv = Parameters<HandlerFetch>[1];
type HandlerContext = Parameters<HandlerFetch>[2];
type ImageTransformInit = RequestInit & {
	cf: {
		image: {
			width: number;
			fit: "scale-down";
			format: "webp";
			quality: number;
		};
	};
};

export default {
	...handler,
	async fetch(request: HandlerRequest, env: HandlerEnv, context: HandlerContext) {
		const url = new URL(request.url);
		if (
			(request.method === "GET" || request.method === "HEAD") &&
			url.pathname.startsWith(PREVIEW_PREFIX)
		) {
			const encodedKey = url.pathname.slice(PREVIEW_PREFIX.length);
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
			const imageRequest = new Request(sourceUrl, {
				headers: { Accept: "image/*" },
			});
			const transformOptions: ImageTransformInit = {
				cf: {
					image: {
						width: PREVIEW_WIDTH,
						fit: "scale-down",
						format: "webp",
						quality: 85,
					},
				},
			};
			const transformed = await fetch(imageRequest, transformOptions);

			if (!transformed.ok) {
				return handler.fetch(
					new Request(sourceUrl, request) as HandlerRequest,
					env,
					context,
				);
			}

			const headers = new Headers(transformed.headers);
			headers.set("Cache-Control", "public, max-age=31536000, immutable");
			return new Response(request.method === "HEAD" ? null : transformed.body, {
				status: transformed.status,
				headers,
			});
		}

		return handler.fetch(request, env, context);
	},
	scheduled: createScheduledHandler(),
};
