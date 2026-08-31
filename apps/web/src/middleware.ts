import { defineMiddleware } from "astro:middleware";

const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);

export const onRequest = defineMiddleware(async (context, next) => {
	const response =
		PHOTO_HOSTS.has(context.url.hostname) && context.url.pathname === "/"
			? await context.rewrite("/albums")
			: await next();

	if (
		context.url.hostname.endsWith(".workers.dev") ||
		context.url.hostname.includes("staging")
	) {
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	}

	return response;
});
