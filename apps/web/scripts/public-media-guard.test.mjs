import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const {
	classifyMediaRead,
	guardPublicOriginalRead,
} = await import("../src/studio/public-media-guard.ts");

function fixtureDatabase() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE media (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE ec_photos (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_posts (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at TEXT, live_revision_id TEXT
		);
		CREATE TABLE ec_pages (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at TEXT, live_revision_id TEXT
		);
		CREATE TABLE ec_albums (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at TEXT, live_revision_id TEXT
		);
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	return {
		sqlite,
		database: {
			prepare(query) {
				const statement = sqlite.prepare(query);
				return {
					bind(...values) {
						return { first: async () => statement.get(...values) ?? null };
					},
				};
			},
		},
	};
}

function addMedia(sqlite, id, storageKey) {
	sqlite.prepare("INSERT INTO media (id, storage_key) VALUES (?, ?)").run(id, storageKey);
}

function addContent(sqlite, collection, {
	id,
	status = "published",
	deletedAt = null,
	liveRevisionId = `${id}-live`,
	data,
}) {
	sqlite.prepare("INSERT INTO revisions (id, data) VALUES (?, ?)")
		.run(liveRevisionId, JSON.stringify(data));
	sqlite.prepare(`
		INSERT INTO ec_${collection} (id, status, deleted_at, live_revision_id)
		VALUES (?, ?, ?, ?)
	`).run(id, status, deletedAt, liveRevisionId);
}

function mediaRequest(storageKey, init, host = "blog.kanouk.com") {
	return new Request(
		`https://${host}/_emdash/api/media/file/${encodeURIComponent(storageKey)}`,
		init,
	);
}

test("published clean Photo is public while draft, deleted, and unreviewed Photos fail closed", async () => {
	const { sqlite, database } = fixtureDatabase();
	for (const [id, storageKey] of [
		["media-clean", "photos/clean.jpg"],
		["media-review", "photos/review.jpg"],
		["media-draft", "photos/draft.jpg"],
		["media-deleted", "photos/deleted.jpg"],
	]) addMedia(sqlite, id, storageKey);
	addContent(sqlite, "photos", {
		id: "photo-clean",
		data: {
			image: { id: "media-clean", meta: { storageKey: "photos/clean.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		},
	});
	addContent(sqlite, "photos", {
		id: "photo-review",
		data: {
			image: { id: "media-review", meta: { storageKey: "photos/review.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "required" },
		},
	});
	addContent(sqlite, "photos", {
		id: "photo-draft",
		status: "draft",
		data: { image: { id: "media-draft", meta: { storageKey: "photos/draft.jpg" } } },
	});
	addContent(sqlite, "photos", {
		id: "photo-deleted",
		deletedAt: "2026-09-06T00:00:00Z",
		data: { image: { id: "media-deleted", meta: { storageKey: "photos/deleted.jpg" } } },
	});

	assert.equal((await classifyMediaRead(
		mediaRequest("photos/clean.jpg", undefined, "photos.kanouk.com"), database,
	)).access, "public");
	for (const key of ["photos/review.jpg", "photos/draft.jpg", "photos/deleted.jpg"]) {
		assert.equal((await classifyMediaRead(
			mediaRequest(key, undefined, "photos.kanouk.com"), database,
		)).access, "denied");
	}
});

test("only recognized media fields in current published post/page revisions are public", async () => {
	const { sqlite, database } = fixtureDatabase();
	const fixtures = [
		["featured", "wp/featured.jpg"],
		["portable", "wp/portable.jpg"],
		["link", "wp/link.jpg"],
		["product", "wp/product.jpg"],
		["dialogue", "wp/dialogue.png"],
		["gallery", "wp/gallery.jpg"],
		["page", "wp/page.jpg"],
		["album", "photos/album-cover.jpg"],
		["html", "wp/html-block.jpg"],
	];
	for (const [id, key] of fixtures) addMedia(sqlite, `media-${id}`, key);
	addContent(sqlite, "posts", {
		id: "post-public",
		data: {
			featured_image: { id: "media-featured" },
			content: [
				{ _type: "image", asset: { _ref: "media-portable" } },
				{ _type: "yohaku.linkCard", imageUrl: "https://blog.kanouk.com/_emdash/api/media/file/wp%2Flink.jpg" },
				{ _type: "yohaku.productCard", imageUrl: "wp/product.jpg" },
				{ _type: "yohaku.dialogue", avatarUrl: "/_emdash/api/media/file/wp/dialogue.png" },
				{ _type: "gallery", images: [{ asset: { url: "https://photos.kanouk.com/_emdash/api/media/file/wp%2Fgallery.jpg" } }] },
				{ _type: "htmlBlock", html: '<figure><img src="/_emdash/api/media/file/wp%2Fhtml-block.jpg" alt=""></figure>' },
				{ _type: "paragraph", body: "wp/orphan.jpg" },
			],
		},
	});
	addContent(sqlite, "pages", {
		id: "page-public",
		data: { content: [{ _type: "image", asset: { _ref: "media-page" } }] },
	});
	addContent(sqlite, "albums", {
		id: "album-public",
		data: { cover_image: { id: "media-album" } },
	});

	for (const [, key] of fixtures) {
		assert.equal((await classifyMediaRead(mediaRequest(key), database)).access, "public", key);
	}
	addMedia(sqlite, "media-orphan", "wp/orphan.jpg");
	assert.equal((await classifyMediaRead(mediaRequest("wp/orphan.jpg"), database)).access, "denied");
});

test("unreviewed Organizer media is denied even when another public surface references it", async () => {
	const { sqlite, database } = fixtureDatabase();
	for (const surface of ["post", "album", "seo"]) {
		const mediaId = `media-restricted-${surface}`;
		const storageKey = `restricted/${surface}.jpg`;
		addMedia(sqlite, mediaId, storageKey);
		addContent(sqlite, "photos", {
			id: `photo-restricted-${surface}`,
			status: "draft",
			data: {
				image: { id: mediaId, meta: { storageKey } },
				source_metadata: { photo_organizer_upload: 1, location_review: "required" },
			},
		});
	}
	addContent(sqlite, "posts", {
		id: "post-restricted-reference",
		data: { featured_image: { id: "media-restricted-post" } },
	});
	addContent(sqlite, "albums", {
		id: "album-restricted-reference",
		data: { cover_image: { id: "media-restricted-album" } },
	});
	sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(
		"site:seo",
		JSON.stringify({ defaultOgImage: { mediaId: "media-restricted-seo" } }),
	);

	for (const surface of ["post", "album", "seo"]) {
		assert.equal((await classifyMediaRead(
			mediaRequest(`restricted/${surface}.jpg`), database,
		)).access, "denied", surface);
		const cleanData = {
			image: {
				id: `media-restricted-${surface}`,
				meta: { storageKey: `restricted/${surface}.jpg` },
			},
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		};
		sqlite.prepare("UPDATE revisions SET data = ? WHERE id = ?").run(
			JSON.stringify(cleanData),
			`photo-restricted-${surface}-live`,
		);
		assert.equal((await classifyMediaRead(
			mediaRequest(`restricted/${surface}.jpg`), database,
		)).access, "public", surface);
	}
});

test("an unreviewed Organizer draft revision vetoes a clean live media reference", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-pending-review", "restricted/pending.jpg");
	addContent(sqlite, "photos", {
		id: "photo-pending-review",
		status: "published",
		data: {
			image: { id: "media-pending-review", meta: { storageKey: "restricted/pending.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		},
	});
	sqlite.prepare("INSERT INTO revisions (id, data) VALUES (?, ?)").run(
		"photo-pending-review-draft",
		JSON.stringify({
			image: { id: "media-pending-review", meta: { storageKey: "restricted/pending.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "required" },
		}),
	);
	sqlite.prepare("UPDATE ec_photos SET draft_revision_id = ? WHERE id = ?").run(
		"photo-pending-review-draft",
		"photo-pending-review",
	);
	assert.equal((await classifyMediaRead(
		mediaRequest("restricted/pending.jpg"), database,
	)).access, "denied");

	sqlite.prepare("UPDATE revisions SET data = ? WHERE id = ?").run(
		JSON.stringify({
			image: { id: "media-pending-review", meta: { storageKey: "restricted/pending.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		}),
		"photo-pending-review-draft",
	);
	assert.equal((await classifyMediaRead(
		mediaRequest("restricted/pending.jpg"), database,
	)).access, "public");
});

test("htmlBlock allows exact quoted image src attributes but not prose or partial values", async () => {
	const { sqlite, database } = fixtureDatabase();
	for (const key of ["html/exact.jpg", "html/single.jpg", "html/prose.jpg", "html/partial.jpg"]) {
		addMedia(sqlite, `media-${key}`, key);
	}
	addContent(sqlite, "posts", {
		id: "post-html-block",
		data: {
			content: [
				{ _type: "htmlBlock", html: '<img src="/_emdash/api/media/file/html%2Fexact.jpg" alt="">' },
				{ _type: "htmlBlock", html: "<img src='html/single.jpg' alt=''>" },
				{ _type: "htmlBlock", html: "Example text: /_emdash/api/media/file/html%2Fprose.jpg" },
				{ _type: "htmlBlock", html: '<img src="/_emdash/api/media/file/html%2Fpartial.jpg?size=large">' },
			],
		},
	});
	assert.equal((await classifyMediaRead(mediaRequest("html/exact.jpg"), database)).access, "public");
	assert.equal((await classifyMediaRead(mediaRequest("html/single.jpg"), database)).access, "public");
	assert.equal((await classifyMediaRead(mediaRequest("html/prose.jpg"), database)).access, "denied");
	assert.equal((await classifyMediaRead(mediaRequest("html/partial.jpg"), database)).access, "denied");
});

test("stale, unpublished, deleted, and unrecognized references do not become public", async () => {
	const { sqlite, database } = fixtureDatabase();
	for (const key of ["stale.jpg", "draft.jpg", "deleted.jpg", "unknown.jpg", "orphan.jpg"]) {
		addMedia(sqlite, `media-${key}`, key);
	}
	addContent(sqlite, "posts", {
		id: "post-current",
		data: { content: [] },
	});
	sqlite.prepare("INSERT INTO revisions (id, data) VALUES (?, ?)").run(
		"post-stale-revision",
		JSON.stringify({ content: [{ _type: "image", asset: { url: "stale.jpg" } }] }),
	);
	addContent(sqlite, "posts", {
		id: "post-draft",
		status: "draft",
		data: { content: [{ _type: "image", asset: { url: "draft.jpg" } }] },
	});
	addContent(sqlite, "pages", {
		id: "page-deleted",
		deletedAt: "2026-09-06T00:00:00Z",
		data: { content: [{ _type: "image", asset: { url: "deleted.jpg" } }] },
	});
	addContent(sqlite, "posts", {
		id: "post-unknown",
		data: { content: [{ _type: "custom", imageUrl: "unknown.jpg" }] },
	});

	for (const key of ["stale.jpg", "draft.jpg", "deleted.jpg", "unknown.jpg", "orphan.jpg"]) {
		assert.equal((await classifyMediaRead(mediaRequest(key), database)).access, "denied", key);
	}
});

test("only the site SEO image setting is an additional public setting reference", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-og", "site/og.jpg");
	addMedia(sqlite, "media-logo", "site/logo.jpg");
	sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(
		"site:seo",
		JSON.stringify({ defaultOgImage: { mediaId: "media-og" } }),
	);
	sqlite.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run(
		"site:logo",
		JSON.stringify({ mediaId: "media-logo" }),
	);
	assert.equal((await classifyMediaRead(mediaRequest("site/og.jpg"), database)).access, "public");
	assert.equal((await classifyMediaRead(mediaRequest("site/logo.jpg"), database)).access, "denied");
});

test("unknown hosts are never anonymous-public and authenticated fallback is explicit", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-public", "public.jpg");
	addContent(sqlite, "posts", {
		id: "public-post",
		data: { featured_image: { id: "media-public" } },
	});
	const unknown = mediaRequest("public.jpg", undefined, "preview.example.test");
	assert.equal((await classifyMediaRead(unknown, database)).access, "denied");
	assert.equal((await classifyMediaRead(unknown, database, {
		authenticate: async () => true,
	})).access, "authenticated");
});

test("explicit loopback and canonical workers.dev hosts support published fixture media", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-public", "public.jpg");
	addContent(sqlite, "posts", {
		id: "public-post",
		data: { featured_image: { id: "media-public" } },
	});
	for (const host of [
		"localhost",
		"127.0.0.1",
		"kanouk-emdash-staging.kanouk.workers.dev",
	]) {
		assert.equal((await classifyMediaRead(mediaRequest("public.jpg", undefined, host), database)).access, "public");
	}
	assert.equal((await classifyMediaRead(
		mediaRequest("public.jpg", undefined, "version-kanouk-emdash-staging.kanouk.workers.dev"),
		database,
	)).access, "denied");
});

test("malformed, backup, NUL, empty, and non-read raw routes are denied", async () => {
	const { database } = fixtureDatabase();
	const authenticate = async () => true;
	for (const request of [
		new Request("https://blog.kanouk.com/_emdash/api/media/file/%E0%A4%A"),
		mediaRequest("backups/export.zip"),
		new Request("https://blog.kanouk.com/_emdash/api/media/file/key%00.jpg"),
		new Request("https://blog.kanouk.com/_emdash/api/media/file/"),
	]) {
		assert.equal((await classifyMediaRead(request, database, { authenticate })).access, "denied");
	}
	assert.equal((await classifyMediaRead(mediaRequest("x.jpg", { method: "POST" }), database, {
		authenticate,
	})).access, "denied");
	assert.equal((await guardPublicOriginalRead(
		mediaRequest("x.jpg", { method: "POST" }), database, { authenticate },
	))?.status, 404);
});
