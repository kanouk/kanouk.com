import assert from "node:assert/strict";
import test from "node:test";

import {
	assignDestinationSlugs,
	buildMediaMappings,
	extractModifiedDates,
	rewriteMediaReferences,
	shouldRetryRequest,
} from "./import-wxr.mjs";

test("destination slugs preserve unique slugs and namespace collisions", () => {
	const records = [
		{ source: { id: "a" }, post: { id: 1, postType: "post", postName: "unique" } },
		{ source: { id: "a" }, post: { id: 2, postType: "page", postName: "about" } },
		{ source: { id: "b" }, post: { id: 3, postType: "page", postName: "about" } },
		{ source: { id: "b" }, post: { id: 4, postType: "post", postName: "" } },
	];
	assert.deepEqual(assignDestinationSlugs(records).map((item) => item.slug), [
		"unique",
		"about-a",
		"about-b",
		"wp-b-4",
	]);
});

test("modified dates are preserved from WXR items", () => {
	const xml = `<rss><channel><item><wp:post_id><![CDATA[42]]></wp:post_id><wp:post_modified><![CDATA[2024-01-02 12:00:00]]></wp:post_modified><wp:post_modified_gmt><![CDATA[2024-01-02 03:00:00]]></wp:post_modified_gmt></item></channel></rss>`;
	assert.deepEqual(extractModifiedDates(xml).get("42"), {
		local: "2024-01-02 12:00:00",
		gmt: "2024-01-02 03:00:00",
	});
});

test("only transient HTTP responses and safe network failures are retried", () => {
	for (const status of [429, 502, 503, 504]) {
		assert.equal(shouldRetryRequest({ status, method: "POST" }), true);
	}
	for (const status of [400, 401, 403, 404, 409, 500]) {
		assert.equal(shouldRetryRequest({ status, method: "GET" }), false);
	}
	assert.equal(shouldRetryRequest({ error: new TypeError("fetch failed"), method: "GET" }), true);
	assert.equal(shouldRetryRequest({ error: new TypeError("fetch failed"), method: "PUT" }), true);
	assert.equal(shouldRetryRequest({ error: new TypeError("fetch failed"), method: "POST" }), false);
});

test("verified WordPress media and derived sizes become local EmDash references", () => {
	const mappings = buildMediaMappings({
		items: {
			"site:42": {
				status: "verified",
				url: "https://example.com/wp-content/uploads/hero.jpg",
				aliases: ["https://example.com/wp-content/uploads/hero-300x200.jpg"],
				public_path: "/_emdash/api/media/file/01ABC.jpg",
				media_id: "01ABC",
				alt: "Hero",
			},
		},
	});
	const result = rewriteMediaReferences([
		{
			_type: "image",
			asset: { _type: "reference", _ref: "42", url: "https://example.com/wp-content/uploads/hero-300x200.jpg" },
		},
		{ _type: "htmlBlock", html: '<img src="https://example.com/wp-content/uploads/hero-640x480.jpg">' },
	], mappings);
	assert.equal(result.value[0].asset._ref, "01ABC");
	assert.equal(result.value[0].asset.provider, "local");
	assert.equal(result.value[1].html, '<img src="/_emdash/api/media/file/01ABC.jpg">');
	assert.equal(result.rewrites, 2);
});
