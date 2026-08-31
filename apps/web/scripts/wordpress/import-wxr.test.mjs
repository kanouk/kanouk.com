import assert from "node:assert/strict";
import test from "node:test";

import { assignDestinationSlugs, extractModifiedDates } from "./import-wxr.mjs";

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
