import type { AstroGlobal } from "astro";

/**
 * EmDash reports a failed read as `{ entry: null, error }` (or `entries: []`)
 * instead of throwing. Treating that as "not found" made a transient D1 hiccup
 * answer 302 -> /404, and the route rule (maxAge 300 + swr 1 day) kept serving
 * that redirect long after the database recovered. A read failure must answer
 * 503 and stay out of every cache, so the next request renders the real page.
 */
export function contentUnavailable(Astro: AstroGlobal, error: unknown): Response {
	if (Astro.cache?.enabled) Astro.cache.set(false);
	console.error("[content] read failed", Astro.url.pathname, error);
	return new Response("Service Unavailable", {
		status: 503,
		headers: { "Cache-Control": "no-store", "Retry-After": "5" },
	});
}

/**
 * A redirect to /404 for content that really is missing. It is kept out of the
 * shared cache so a page published (or a lookup that recovers) right after the
 * miss is reachable on the very next request.
 */
export function redirectNotFound(Astro: AstroGlobal): Response {
	if (Astro.cache?.enabled) Astro.cache.set(false);
	const response = Astro.redirect("/404");
	response.headers.set("Cache-Control", "no-store");
	return response;
}
