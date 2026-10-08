import type { APIRoute } from "astro";

export const prerender = false;

const COOKIE = "kanouk-admin-bar";
const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com", "localhost", "127.0.0.1"]);

/**
 * A UI marker for the photo site, which cannot see the blog's session cookie.
 * The blog's admin bar sets it (same-site request) while an admin is signed in;
 * it only makes the photo pages show the bar. Every link in the bar still needs
 * the blog's login, so the marker grants nothing.
 */
export const GET: APIRoute = ({ url, cookies }) => {
	const noStore = { "Cache-Control": "private, no-store" };
	const host = url.hostname;
	if (!PHOTO_HOSTS.has(host) && !host.endsWith(".workers.dev")) {
		return new Response("Not Found", { status: 404, headers: noStore });
	}
	const options = { path: "/", sameSite: "lax", secure: url.protocol === "https:", httpOnly: true } as const;
	if (url.searchParams.get("state") === "off") cookies.delete(COOKIE, options);
	else cookies.set(COOKIE, "1", { ...options, maxAge: 60 * 60 * 24 * 30 });
	return new Response(null, { status: 204, headers: noStore });
};
