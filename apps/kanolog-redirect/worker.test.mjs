import { test } from "node:test";
import assert from "node:assert/strict";
import mapping from "./mapping.json" with { type: "json" };
import worker from "./worker.mjs";

const fetch = (path, options) => worker.fetch(new Request(`https://kanolog.net${path}`, options));

test("every mapped page redirects directly across both protocols, hosts and trailing slashes", async () => {
	for (const [path, target] of Object.entries(mapping.paths)) {
		assert.equal(new URL(target).origin, "https://blog.kanouk.com");
		for (const origin of ["http://kanolog.net", "https://kanolog.net", "http://www.kanolog.net", "https://www.kanolog.net"]) {
			for (const suffix of path === "/" ? [""] : ["", "/"]) {
				const response = await worker.fetch(new Request(`${origin}${path}${suffix}?utm_source=legacy`));
				assert.equal(response.status, 301, `${origin}${path}${suffix}`);
				assert.equal(response.headers.get("Location"), target);
			}
		}
	}
});

test("WordPress query IDs resolve only to explicitly mapped published items", async () => {
	for (const [id, target] of Object.entries(mapping.ids)) {
		const response = await fetch(`/?p=${id}`);
		assert.equal(response.status, 301);
		assert.equal(response.headers.get("Location"), target);
	}
	const [id, target] = Object.entries(mapping.ids)[0];
	assert.equal((await fetch(`/index.php?page_id=${id}`)).headers.get("Location"), target);
	for (const path of ["/?p=999999999", "/?p=__proto__", "/?p=1&p=2", "/?p=1&page_id=2", "/?p=-1", "/?p=", "/?attachment_id=1"]) assert.equal((await fetch(path)).status, 404);
});

test("unknown paths, prefixes and encoded separators never redirect to home or arbitrary destinations", async () => {
	const firstPath = Object.keys(mapping.paths).find((path) => path !== "/");
	for (const path of ["/not-a-real-post", "/wp-admin/", "/__proto__", `${firstPath}/extra`, "/stream%2f8831", "/%5cstream/8831", "/%zz", "/%00", "/?p=https://example.org/"]) {
		const response = await fetch(path);
		assert.equal(response.status, 404, path);
		assert.equal(response.headers.get("Location"), null);
	}
	assert.equal((await worker.fetch(new Request("https://example.org/"))).status, 404);
});

test("search, feed, sitemap and archive pagination use explicit new endpoints", async () => {
	for (const [path, target] of [["/?s=京都", "https://blog.kanouk.com/search?q=%E4%BA%AC%E9%83%BD"], ["/?paged=2", "https://blog.kanouk.com/posts?page=2"], ["/feed/", "https://blog.kanouk.com/rss.xml"], ["/wp-sitemap.xml", "https://blog.kanouk.com/sitemap.xml"]]) assert.equal((await fetch(path)).headers.get("Location"), target);
});

test("taxonomy query aliases resolve only to known mapped categories or tags", async () => {
	for (const [parameter, targets] of Object.entries(mapping.queries)) {
		for (const [value, target] of Object.entries(targets)) {
			assert.equal((await fetch(`/?${parameter}=${encodeURIComponent(value)}`)).headers.get("Location"), target);
		}
		assert.equal((await fetch(`/?${parameter}=not-a-real-term`)).status, 404);
		assert.equal((await fetch(`/?${parameter}=1&${parameter}=2`)).status, 404);
	}
});

test("GET and HEAD are safe; writes are refused; crawlers are permitted", async () => {
	assert.equal((await fetch("/", { method: "HEAD" })).status, 301);
	assert.equal(await (await fetch("/missing", { method: "HEAD" })).text(), "");
	assert.equal((await fetch("/", { method: "POST" })).status, 405);
	assert.match(await (await fetch("/robots.txt")).text(), /Allow: \/\n/);
	assert.equal((await fetch("/")).headers.get("X-Robots-Tag"), null);
	const preview = await worker.fetch(new Request("https://kanolog-redirect.kanouk.workers.dev/"));
	assert.equal(preview.status, 301);
	assert.match(preview.headers.get("X-Robots-Tag"), /noindex/);
});
