import mapping from "./mapping.json" with { type: "json" };

const publicHosts = new Set(["kanolog.net", "www.kanolog.net"]);
const previewHost = "kanolog-redirect.kanouk.workers.dev";

function normalizedPath(pathname) {
	if (/%2f|%5c/i.test(pathname)) return null;
	try {
		const path = decodeURIComponent(pathname);
		if (/[\u0000-\u001f\\]/.test(path)) return null;
		return path.replace(/\/+$/, "") || "/";
	} catch {
		return null;
	}
}

export function redirectTarget(url) {
	const path = normalizedPath(url.pathname);
	if (!path) return null;
	if (path === "/" || path === "/index.php") {
		if (url.searchParams.has("attachment_id")) return null;
		const ids = [...url.searchParams.getAll("p"), ...url.searchParams.getAll("page_id")];
		if (ids.length) {
			if (new Set(ids).size !== 1 || !/^[1-9]\d*$/.test(ids[0])) return null;
			return Object.hasOwn(mapping.ids, ids[0]) ? mapping.ids[ids[0]] : null;
		}
		for (const [parameter, targets] of Object.entries(mapping.queries)) {
			if (!url.searchParams.has(parameter)) continue;
			const values = url.searchParams.getAll(parameter);
			if (values.length !== 1) return null;
			return Object.hasOwn(targets, values[0]) ? targets[values[0]] : null;
		}
		if (url.searchParams.has("s")) {
			const target = new URL("https://blog.kanouk.com/search");
			target.searchParams.set("q", url.searchParams.get("s"));
			return target.href;
		}
		const page = url.searchParams.get("paged");
		if (page && /^[1-9]\d*$/.test(page)) return `https://blog.kanouk.com/posts?page=${page}`;
		return mapping.paths["/"];
	}
	if (path === "/feed" || path === "/rss" || path === "/rss2") return "https://blog.kanouk.com/rss.xml";
	if (path === "/sitemap.xml" || path === "/sitemap_index.xml" || path === "/wp-sitemap.xml") return "https://blog.kanouk.com/sitemap.xml";
	// Do not prefix-match: an unknown path must not inherit an unrelated article.
	return Object.hasOwn(mapping.paths, path) ? mapping.paths[path] : null;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const preview = url.hostname === previewHost;
		const headers = new Headers({
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "strict-origin-when-cross-origin",
		});
		if (preview) headers.set("X-Robots-Tag", "noindex, nofollow");
		if (!publicHosts.has(url.hostname) && !preview) return new Response(null, { status: 404, headers });
		if (request.method !== "GET" && request.method !== "HEAD") {
			headers.set("Allow", "GET, HEAD");
			return new Response(null, { status: 405, headers });
		}
		if (url.pathname === "/robots.txt") {
			headers.set("Content-Type", "text/plain; charset=utf-8");
			return new Response(request.method === "HEAD" ? null : "User-agent: *\nAllow: /\nSitemap: https://blog.kanouk.com/sitemap.xml\n", { headers });
		}
		const target = redirectTarget(url);
		if (target) {
			headers.set("Location", target);
			headers.set("Cache-Control", "public, max-age=3600");
			return new Response(null, { status: 301, headers });
		}
		headers.set("Content-Type", "text/html; charset=utf-8");
		headers.set("X-Robots-Tag", "noindex");
		headers.set("Cache-Control", "no-store");
		return new Response(request.method === "HEAD" ? null : '<!doctype html><html lang="ja"><meta charset="utf-8"><title>ページが見つかりません</title><h1>ページが見つかりません</h1><p>ブログは移転しました。このURLに対応する公開ページは確認できません。</p><p><a href="https://blog.kanouk.com/">カノログを開く</a></p></html>', { status: 404, headers });
	},
};
