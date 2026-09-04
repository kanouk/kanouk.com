import { defineMiddleware } from "astro:middleware";

const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);
const BLOG_HOSTS = new Set(["blog.kanouk.com", "blog-staging.kanouk.com"]);

const PHOTO_ROUTE = /^\/(?:albums|p|photos|media)(?:\/|$)/;
const BLOG_ROUTE = /^\/(?:posts|pages|category|tag|archives)(?:\/|$)/;
const PUBLIC_MEDIA_READ_ROUTE = /^\/_emdash\/api\/media\/file\//;

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

function appendVaryHeader(response: Response, value: string) {
	const values = (response.headers.get("Vary") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (values.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
	response.headers.append("Vary", value);
}

export const onRequest = defineMiddleware(async (context, next) => {
	const isPhotoHost = PHOTO_HOSTS.has(context.url.hostname);
	const isBlogHost = BLOG_HOSTS.has(context.url.hostname);
	const blogOrigin = context.url.hostname === "photos-staging.kanouk.com"
		? "https://blog-staging.kanouk.com"
		: "https://blog.kanouk.com";
	const photoOrigin = context.url.hostname === "blog-staging.kanouk.com"
		? "https://photos-staging.kanouk.com"
		: "https://photos.kanouk.com";
	const crossHostRedirect = (target: string) => {
		// Route rules are path-based while this Worker serves both hosts. A cached
		// redirect for /albums on the blog host must never become the /albums
		// response on the photo host (and vice versa).
		context.cache.set(false);
		const response = context.redirect(target, 308);
		appendVaryHeader(response, "Host");
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	};
	const privateNotFound = () => {
		context.cache.set(false);
		const response = new Response("Not Found", {
			status: 404,
			headers: { "Cache-Control": "private, no-store" },
		});
		appendVaryHeader(response, "Host");
		return response;
	};
	const requestHasPrivateState =
		!new Set(["GET", "HEAD"]).has(context.request.method) ||
		Boolean(context.request.headers.get("authorization")) ||
		Boolean(context.cookies.get("astro-session")) ||
		context.cookies.get("emdash-edit-mode")?.value === "true" ||
		context.url.searchParams.has("_preview") ||
		new Set(["/search", "/photo-search"]).has(context.url.pathname) ||
		context.url.pathname.startsWith("/_emdash/");
	if (isPhotoHost && BLOG_ROUTE.test(context.url.pathname)) {
		return crossHostRedirect(`${blogOrigin}${context.url.pathname}${context.url.search}`);
	}
	if (isPhotoHost && context.url.pathname.startsWith("/_emdash/")) {
		if (
			PUBLIC_MEDIA_READ_ROUTE.test(context.url.pathname) &&
			new Set(["GET", "HEAD"]).has(context.request.method)
		) {
			// The Worker validates that the key belongs to an allowed live Photo
			// before this read-only route reaches EmDash media delivery.
		} else if (
			context.url.pathname.startsWith("/_emdash/admin") &&
			new Set(["GET", "HEAD"]).has(context.request.method)
		) {
			return crossHostRedirect(`${blogOrigin}${context.url.pathname}${context.url.search}`);
		} else {
			return privateNotFound();
		}
	}
	if (isBlogHost && (PHOTO_ROUTE.test(context.url.pathname) || context.url.pathname === "/photo-search")) {
		const pathname = context.url.pathname === "/photo-search" ? "/search" : context.url.pathname;
		return crossHostRedirect(`${photoOrigin}${pathname}${context.url.search}`);
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

	// Workers Cache is shared by every hostname attached to this Worker and its
	// base key omits the host. These sites intentionally render different
	// responses for the same path, so keep their cached variants isolated.
	appendVaryHeader(routedResponse, "Host");

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
