import { defineMiddleware } from "astro:middleware";

const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);

export const onRequest = defineMiddleware(async (context, next) => {
	const isPhotoHost = PHOTO_HOSTS.has(context.url.hostname);
	const response = isPhotoHost && context.url.pathname === "/"
		? await context.rewrite("/albums")
		: isPhotoHost && context.url.pathname === "/search"
			? await context.rewrite("/photo-search")
			: await next();

	if (
		context.url.hostname.endsWith(".workers.dev") ||
		context.url.hostname.includes("staging")
	) {
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	}

	return response;
});
