import assert from "node:assert/strict";
import test from "node:test";

import {
	assignDestinationSlugs,
	buildMediaMappings,
	buildSmugMugMappings,
	extractModifiedDates,
	featuredMediaValue,
	loadContentIds,
	rewriteMediaReferences,
	rewriteSmugMugReferences,
	shouldRetryRequest,
	storedMigrationDataMatches,
	storedMigrationItemIsConverged,
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

test("stored migration fingerprints cannot hide sanitized portable text", () => {
	const desired = {
		fingerprint: "same-fingerprint",
		data: {
			title: "Quiz",
			source_url: "https://example.com/quiz",
			source_id: "site:1",
			content: [{ _type: "yohaku.quiz", questions: [{ question: "Q" }] }],
		},
	};
	const stored = {
		data: {
			...desired.data,
			source_metadata: { migration_fingerprint: desired.fingerprint },
			content: [{ _type: "htmlBlock", html: "[ays_quiz id='1']" }],
		},
	};
	assert.equal(storedMigrationDataMatches(stored, desired), false);
	stored.data.content = desired.data.content;
	assert.equal(storedMigrationDataMatches(stored, desired), true);
});

test("stored migration comparison follows JSON transport semantics", () => {
	const desired = {
		fingerprint: "same-fingerprint",
		data: {
			title: "Quiz",
			source_url: "https://example.com/quiz",
			source_id: "example:1",
			content: [{ _type: "yohaku.quiz", title: "Quiz", description: undefined }],
		},
	};
	const stored = {
		data: {
			title: desired.data.title,
			source_url: desired.data.source_url,
			source_id: desired.data.source_id,
			source_metadata: { migration_fingerprint: desired.fingerprint },
			content: [{ _type: "yohaku.quiz", title: "Quiz" }],
		},
	};

	assert.equal(storedMigrationDataMatches(stored, desired), true);
	stored.data.source_metadata.migration_fingerprint = "legacy-fingerprint";
	desired.legacyFingerprint = "legacy-fingerprint";
	assert.equal(storedMigrationDataMatches(stored, desired), true);
});

test("a matching published draft is not treated as live convergence", () => {
	const desired = {
		fingerprint: "same-fingerprint",
		status: "published",
		data: {
			title: "Published title",
			source_url: "https://example.com/post",
			source_id: "example:2",
			content: [{ _type: "block", children: [] }],
		},
	};
	const item = {
		status: "published",
		draftRevisionId: "draft-revision",
		data: {
			title: desired.data.title,
			source_url: desired.data.source_url,
			source_id: desired.data.source_id,
			source_metadata: { migration_fingerprint: desired.fingerprint },
			content: desired.data.content,
		},
	};

	assert.equal(storedMigrationDataMatches(item, desired), true);
	assert.equal(storedMigrationItemIsConverged(item, desired), false);
	item.draftRevisionId = null;
	assert.equal(storedMigrationItemIsConverged(item, desired), true);
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
	assert.deepEqual(featuredMediaValue("https://example.com/wp-content/uploads/hero.jpg", mappings), {
		id: "01ABC",
		provider: "local",
		alt: "Hero",
	});
	assert.deepEqual(featuredMediaValue("https://elsewhere.example/image.jpg", mappings), {
		id: "",
		provider: "external",
		src: "https://elsewhere.example/image.jpg",
		alt: "",
	});
});

test("content index follows cursors and keys entries by stored slug", async () => {
	const calls = [];
	const client = {
		async get(pathname) {
			calls.push(pathname);
			return calls.length === 1
				? { data: { items: [{ id: "a", slug: "%e6%97%a5%e6%9c%ac%e8%aa%9e" }], nextCursor: "next" } }
				: { data: { items: [{ id: "b", slug: "second" }] } };
		},
	};
	const ids = await loadContentIds(client, ["posts"]);
	assert.equal(ids.get("posts:%e6%97%a5%e6%9c%ac%e8%aa%9e"), "a");
	assert.equal(ids.get("posts:second"), "b");
	assert.match(calls[1], /cursor=next/);
});

test("verified SmugMug assets rewrite image, photo, and album URLs", () => {
	const mappings = buildSmugMugMappings([{
		album: {
			slug: "stations",
			source: { web_uri: "https://kanolog.smugmug.com/Stations" },
			destination: { emdash_content_id: "album-id" },
		},
		assets: [{
			source: { image_key: "abc123" },
			destination: {
				photo_path: "/photos/kph-stable",
				emdash_content_id: "photo-id",
				emdash_media_id: "media-id",
				r2_object_key: "01ABC.jpg",
			},
			verification: { r2_roundtrip_verified: true },
		}],
	}]);
	const result = rewriteSmugMugReferences([
		{ _type: "image", asset: { url: "https://photos.smugmug.com/Stations/i-abc123/0/hash/M/file.jpg", _ref: "old" } },
		{ _type: "htmlBlock", html: '<a href="https://kanolog.smugmug.com/Stations/i-abc123/A">photo</a>' },
		{ _type: "htmlBlock", html: '<a href="https://kanolog.smugmug.com/Stations/">album</a>' },
	], mappings);
	assert.equal(result.value[0].asset._ref, "media-id");
	assert.equal(result.value[0].asset.url, "/_emdash/api/media/file/01ABC.jpg");
	assert.match(result.value[1].html, /https:\/\/photos\.kanouk\.com\/photos\/kph-stable/);
	assert.match(result.value[2].html, /https:\/\/photos\.kanouk\.com\/albums\/stations/);
	assert.equal(result.rewrites, 3);
});
