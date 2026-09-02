import { defineMiddleware } from "astro:middleware";

const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);
const BLOG_HOSTS = new Set(["blog.kanouk.com", "blog-staging.kanouk.com"]);

const PHOTO_ROUTE = /^\/(?:albums|p|photos|media)(?:\/|$)/;
const BLOG_ROUTE = /^\/(?:posts|pages|category|tag|archives)(?:\/|$)/;

async function filteredSitemapIndex(response: Response, photoHost: boolean) {
	if (!response.ok) return response;
	const xml = await response.text();
	const allowed = photoHost
		? new Set(["sitemap-albums.xml", "sitemap-photos.xml"])
		: new Set(["sitemap-posts.xml", "sitemap-pages.xml"]);
	const filtered = xml.replace(/\s*<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/g, (block, location) =>
		allowed.has(new URL(location).pathname.slice(1)) ? block : "",
	);
	return new Response(filtered, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function canonicalizedPhotoSitemap(response: Response) {
	if (!response.ok) return response;
	const xml = (await response.text()).replaceAll(
		"https://blog.kanouk.com/",
		"https://photos.kanouk.com/",
	);
	return new Response(xml, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export const onRequest = defineMiddleware(async (context, next) => {
	const isPhotoHost = PHOTO_HOSTS.has(context.url.hostname);
	const isBlogHost = BLOG_HOSTS.has(context.url.hostname);
	const requestHasPrivateState =
		!new Set(["GET", "HEAD"]).has(context.request.method) ||
		Boolean(context.request.headers.get("authorization")) ||
		Boolean(context.cookies.get("astro-session")) ||
		context.cookies.get("emdash-edit-mode")?.value === "true" ||
		context.url.searchParams.has("_preview") ||
		new Set(["/search", "/photo-search"]).has(context.url.pathname) ||
		context.url.pathname.startsWith("/_emdash/");
	if (isPhotoHost && BLOG_ROUTE.test(context.url.pathname)) {
		return context.redirect(`https://blog.kanouk.com${context.url.pathname}${context.url.search}`, 308);
	}
	if (isBlogHost && (PHOTO_ROUTE.test(context.url.pathname) || context.url.pathname === "/photo-search")) {
		const pathname = context.url.pathname === "/photo-search" ? "/search" : context.url.pathname;
		return context.redirect(`https://photos.kanouk.com${pathname}${context.url.search}`, 308);
	}
	const response = isPhotoHost && context.url.pathname === "/"
		? await context.rewrite("/albums")
		: isPhotoHost && context.url.pathname === "/search"
			? await context.rewrite("/photo-search")
			: await next();
	let routedResponse =
		context.url.pathname === "/sitemap.xml" && (isPhotoHost || isBlogHost)
			? await filteredSitemapIndex(response, isPhotoHost)
			: response;
	if (isPhotoHost && /^\/sitemap-(?:albums|photos)\.xml$/.test(context.url.pathname)) {
		routedResponse = await canonicalizedPhotoSitemap(routedResponse);
	}

	if (
		context.url.hostname.endsWith(".workers.dev") ||
		context.url.hostname.includes("staging")
	) {
		routedResponse.headers.set("X-Robots-Tag", "noindex, nofollow");
	}

	// Route rules cache public HTML only. Authenticated/editor/preview responses
	// and cookie-setting responses must never enter the shared edge cache.
	if (requestHasPrivateState || routedResponse.headers.has("set-cookie")) {
		context.cache.set(false);
		routedResponse.headers.set("Cache-Control", "private, no-store");
	}

	return routedResponse;
});
