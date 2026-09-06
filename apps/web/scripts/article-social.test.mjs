import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const {
	resolveArticleSocial,
	resolveInternalLinkPreview,
} = await import("../src/utils/article-social.ts");

const BLOG = "https://blog.kanouk.com";
const PHOTOS = "https://photos.kanouk.com";
const FALLBACK = `${BLOG}/kanolog-no-image.png`;

function fixtureDatabase() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE media (
			id TEXT PRIMARY KEY, storage_key TEXT NOT NULL, status TEXT NOT NULL
		);
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE ec_posts (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_pages (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_photos (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_albums (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_url_mappings (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE _emdash_seo (
			collection TEXT NOT NULL, content_id TEXT NOT NULL,
			seo_image TEXT, seo_description TEXT
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

function addMedia(sqlite, id, storageKey, status = "ready") {
	sqlite.prepare("INSERT INTO media VALUES (?, ?, ?)").run(id, storageKey, status);
}

function addContent(sqlite, collection, {
	id,
	slug = id,
	status = "published",
	deletedAt = null,
	data,
	draftData,
}) {
	const liveRevisionId = `${id}-live`;
	sqlite.prepare("INSERT INTO revisions VALUES (?, ?)").run(liveRevisionId, JSON.stringify(data));
	let draftRevisionId = null;
	if (draftData) {
		draftRevisionId = `${id}-draft`;
		sqlite.prepare("INSERT INTO revisions VALUES (?, ?)").run(draftRevisionId, JSON.stringify(draftData));
	}
	sqlite.prepare(`
		INSERT INTO ec_${collection}
			(id, slug, status, deleted_at, live_revision_id, draft_revision_id)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(id, slug, status, deletedAt, liveRevisionId, draftRevisionId);
}

function addMapping(sqlite, id, data) {
	addContent(sqlite, "url_mappings", { id, data });
}

test("standard body media supplies the OG image and body excerpt", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-standard", "posts/standard.jpg");
	const data = {
		title: "Standard",
		content: [
			{ _type: "block", children: [{ _type: "span", text: "  本文から   説明文を作ります。 " }] },
			{ _type: "image", asset: { _ref: "media-standard" } },
		],
	};
	addContent(sqlite, "posts", { id: "post-standard", data });

	assert.deepEqual(await resolveArticleSocial(database, { id: "post-standard", data }), {
		description: "本文から 説明文を作ります。",
		imageUrl: `${BLOG}/_emdash/api/media/file/posts%2Fstandard.jpg`,
	});
	sqlite.close();
});

test("explicit SEO description and safe external image outrank featured media", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-featured", "posts/featured.jpg");
	const data = {
		excerpt: "excerpt",
		seo: { description: "SEO description", image: "https://images.example.test/editorial.jpg" },
		featured_image: { id: "media-featured" },
		content: [],
	};
	addContent(sqlite, "posts", { id: "post-seo", data });
	assert.deepEqual(await resolveArticleSocial(database, { id: "post-seo", data }), {
		description: "SEO description",
		imageUrl: "https://images.example.test/editorial.jpg",
	});
	assert.equal((await resolveArticleSocial(database, {
		id: "post-seo",
		data: { ...data, seo: { image: JSON.stringify({ mediaId: "media-featured" }) } },
	})).imageUrl, `${BLOG}/_emdash/api/media/file/posts%2Ffeatured.jpg`);
	assert.equal((await resolveArticleSocial(database, {
		id: "post-seo",
		data: { ...data, seo: null, featured_image: null, content: [{ _type: "image", asset: { url: "posts/featured.jpg" } }] },
	})).imageUrl, `${BLOG}/_emdash/api/media/file/posts%2Ffeatured.jpg`);
	sqlite.close();
});

test("legacy WordPress SEO images resolve only through an exact verified media mapping", async () => {
	const { sqlite, database } = fixtureDatabase();
	const oldUrl = "https://kanolog.net/wp-content/uploads/2025/02/PXL_20250215_040746163-scaled.jpg";
	addMedia(sqlite, "media-kyoto", "photos/kyoto.jpg");
	addContent(sqlite, "albums", { id: "album-kyoto", data: { title: "Kyoto" } });
	addContent(sqlite, "photos", {
		id: "photo-kyoto",
		data: {
			album: "album-kyoto",
			image: { id: "media-kyoto", meta: { storageKey: "photos/kyoto.jpg" } },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		},
	});
	addMapping(sqlite, "mapping-media", {
		source_url: oldUrl,
		target_url: "/_emdash/api/media/file/photos%2Fkyoto.jpg",
		target_kind: "media",
		verified: true,
	});
	const resolved = await resolveArticleSocial(database, {
		id: "post-kyoto",
		data: { seo: { image: oldUrl }, content: [] },
	});
	assert.equal(resolved.imageUrl, `${BLOG}/_emdash/api/media/file/photos%2Fkyoto.jpg`);

	const nearMatch = await resolveArticleSocial(database, {
		id: "post-near-match",
		data: { seo: { image: oldUrl.replace("-scaled.jpg", "-1024x771.jpg") }, content: [] },
	});
	assert.equal(nearMatch.imageUrl, FALLBACK);
	sqlite.close();
});

test("published photo and album blocks resolve, while private or unreviewed photos fall back", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-photo", "photos/public.jpg");
	addMedia(sqlite, "media-private", "photos/private.jpg");
	addContent(sqlite, "albums", {
		id: "album-public",
		slug: "trip",
		data: { title: "Trip", cover_image: { id: "media-photo" } },
	});
	addContent(sqlite, "photos", {
		id: "photo-public",
		slug: "view",
		data: {
			album: "album-public",
			image: { id: "media-photo" },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		},
	});
	addContent(sqlite, "photos", {
		id: "photo-private",
		data: {
			album: "album-public",
			image: { id: "media-private" },
			source_metadata: { photo_organizer_upload: 1, location_review: "required" },
		},
	});

	const photo = await resolveArticleSocial(database, {
		data: { content: [{ _type: "yohaku.photo", id: "view", albumId: "trip" }] },
	});
	assert.equal(photo.imageUrl, `${PHOTOS}/_emdash/api/media/file/photos%2Fpublic.jpg`);
	const album = await resolveArticleSocial(database, {
		data: { content: [{ _type: "yohaku.album", id: "trip" }] },
	});
	assert.equal(album.imageUrl, `${PHOTOS}/_emdash/api/media/file/photos%2Fpublic.jpg`);
	const privatePhoto = await resolveArticleSocial(database, {
		data: { content: [{ _type: "yohaku.photo", id: "photo-private", albumId: "trip" }] },
	});
	assert.equal(privatePhoto.imageUrl, FALLBACK);
	sqlite.close();
});

test("preview-v2 derivatives normalize to classified raw media and cannot expose unreviewed media", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-public-preview", "photos/public preview.jpg");
	addMedia(sqlite, "media-private-preview", "photos/private.jpg");
	addContent(sqlite, "albums", { id: "album-preview", data: { title: "Preview album" } });
	addContent(sqlite, "photos", {
		id: "photo-public-preview",
		data: {
			album: "album-preview",
			image: { id: "media-public-preview" },
			source_metadata: { photo_organizer_upload: 1, location_review: "clean" },
		},
	});
	addContent(sqlite, "photos", {
		id: "photo-private-preview",
		data: {
			album: "album-preview",
			image: { id: "media-private-preview" },
			source_metadata: { photo_organizer_upload: 1, location_review: "required" },
		},
	});

	const publicPreview = `${PHOTOS}/_yohaku/media/preview-v2/1200/webp/${encodeURIComponent("photos/public preview.jpg")}`;
	assert.equal((await resolveArticleSocial(database, {
		data: { seo: { image: publicPreview }, content: [] },
	})).imageUrl, `${PHOTOS}/_emdash/api/media/file/photos%2Fpublic%20preview.jpg`);

	const privatePreview = `${PHOTOS}/_yohaku/media/preview-v2/1200/webp/${encodeURIComponent("photos/private.jpg")}`;
	assert.equal((await resolveArticleSocial(database, {
		data: { seo: { image: privatePreview }, content: [] },
	})).imageUrl, FALLBACK);
	assert.equal((await resolveArticleSocial(database, {
		data: { seo: { image: `${PHOTOS}/_yohaku/media/preview-v1/1200/private.jpg` }, content: [] },
	})).imageUrl, FALLBACK);
	sqlite.close();
});

test("no image and draft preview content return the raster fallback without draft text", async () => {
	const { sqlite, database } = fixtureDatabase();
	assert.deepEqual(await resolveArticleSocial(database, {
		data: { excerpt: "Safe excerpt", content: [] },
	}), { description: "Safe excerpt", imageUrl: FALLBACK });
	assert.deepEqual(await resolveArticleSocial(database, {
		id: "draft-only",
		data: { id: "draft-only", excerpt: "Private draft", content: [] },
	}, { isPreview: true }), { description: "", imageUrl: FALLBACK });

	addMedia(sqlite, "media-site-og", "site/default-og.png");
	sqlite.prepare("INSERT INTO options VALUES (?, ?)").run(
		"site:seo",
		JSON.stringify({ defaultOgImage: { mediaId: "media-site-og" } }),
	);
	assert.equal((await resolveArticleSocial(database, {
		data: { content: [] },
	})).imageUrl, `${BLOG}/_emdash/api/media/file/site%2Fdefault-og.png`);
	sqlite.close();
});

test("internal previews expose only published routes and exact legacy content mappings", async () => {
	const { sqlite, database } = fixtureDatabase();
	addMedia(sqlite, "media-post", "posts/card.jpg");
	addContent(sqlite, "posts", {
		id: "post-public",
		slug: "public-slug",
		data: { title: "Public post", excerpt: "Public excerpt", featured_image: { id: "media-post" } },
	});
	addContent(sqlite, "posts", {
		id: "post-draft",
		slug: "draft-slug",
		status: "draft",
		data: { title: "Draft post", excerpt: "Must stay private" },
	});
	addMapping(sqlite, "mapping-post", {
		source_url: "https://kanolog.net/legacy-public/",
		target_url: "/posts/post-public",
		target_kind: "post",
		verified: false,
	});

	const direct = await resolveInternalLinkPreview(database, `${BLOG}/posts/public-slug`);
	assert.deepEqual(direct, {
		url: `${BLOG}/posts/post-public`,
		title: "Public post",
		description: "Public excerpt",
		imageUrl: `${BLOG}/_emdash/api/media/file/posts%2Fcard.jpg`,
	});
	assert.deepEqual(await resolveInternalLinkPreview(database, "https://kanolog.net/legacy-public/"), direct);
	assert.equal(await resolveInternalLinkPreview(database, `${BLOG}/posts/draft-slug`), null);
	assert.equal(await resolveInternalLinkPreview(database, `${BLOG}/_emdash/admin/content/posts/post-public`), null);
	assert.equal(await resolveInternalLinkPreview(database, `${BLOG}/posts/%E0%A4%A`), null);
	sqlite.close();
});
