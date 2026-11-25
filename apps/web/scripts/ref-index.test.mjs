import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { d1, REF_INDEX_DOWN, REF_INDEX_UP } from "./d1-fixture.mjs";

const { classifyMediaRead } = await import("../src/studio/public-media-guard.ts");
const {
	drainRefIndex,
	entryRefs,
	htmlSrcValues,
	mediaAccessFromIndex,
	mediaUrlRefs,
} = await import("../src/utils/ref-index.mjs");
const {
	ALBUM_ARTICLES_QUERY,
	INDEXED_ALBUM_ARTICLES_QUERY,
} = await import("../src/utils/album-articles.mjs");
const {
	ARTICLE_PHOTO_LINKS_QUERY,
	INDEXED_ARTICLE_PHOTO_LINKS_QUERY,
} = await import("../src/utils/article-photo-links.mjs");

// Shaped like production: revisions carry collection/entry_id, entries carry
// draft pointers and locale.
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const entryColumns = `id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
		live_revision_id TEXT, draft_revision_id TEXT, locale TEXT DEFAULT 'ja', published_at TEXT`;
	sqlite.exec(`
		CREATE TABLE media (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL);
		CREATE TABLE revisions (id TEXT PRIMARY KEY, collection TEXT, entry_id TEXT, data TEXT NOT NULL);
		CREATE TABLE ec_photos (${entryColumns});
		CREATE TABLE ec_posts (${entryColumns});
		CREATE TABLE ec_pages (${entryColumns});
		CREATE TABLE ec_albums (${entryColumns});
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	sqlite.exec(REF_INDEX_UP);
	const database = d1(sqlite);
	const add = (collection, id, data, { status = "published", deletedAt = null, slug = id, locale = "ja", publishedAt = "2026-09-01" } = {}) => {
		sqlite.prepare("INSERT INTO revisions (id, collection, entry_id, data) VALUES (?, ?, ?, ?)")
			.run(`${id}-live`, collection, id, JSON.stringify(data));
		sqlite.prepare(`INSERT INTO ec_${collection} (id, slug, status, deleted_at, live_revision_id, locale, published_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, slug, status, deletedAt, `${id}-live`, locale, publishedAt);
	};
	const drain = async () => {
		while ((await drainRefIndex(database, { limit: 3 })).processed > 0);
	};
	const dirtyCount = () => sqlite.prepare("SELECT count(*) AS c FROM kanouk_ref_dirty").get().c;
	return { sqlite, database, add, drain, dirtyCount };
}

const read = (key) => new Request(`https://photos.kanouk.com/_emdash/api/media/file/${encodeURIComponent(key)}`);
const organizerPhoto = (mediaId, storageKey, review) => ({
	image: { id: mediaId, meta: { storageKey } },
	album: "album-1",
	source_metadata: { photo_organizer_upload: 1, location_review: review },
});

test("migration backfills every existing entry as dirty and the drain builds the index", async () => {
	const { sqlite, database, add, drain, dirtyCount } = fixture();
	sqlite.exec(REF_INDEX_DOWN);
	sqlite.prepare("INSERT INTO media VALUES (?, ?)").run("m1", "a/one.jpg");
	add("posts", "p1", { featured_image: { id: "m1" } });
	// Created before the index existed: the up migration must still cover it.
	sqlite.exec(REF_INDEX_UP);
	assert.equal(dirtyCount(), 2); // p1 and the site:seo option
	assert.equal(await mediaAccessFromIndex(database, "a/one.jpg"), "dirty");
	await drain();
	assert.equal(dirtyCount(), 0);
	assert.equal(await mediaAccessFromIndex(database, "a/one.jpg"), "public");
});

test("a photo moved back to location review is denied on the very next read, before any drain", async () => {
	const { sqlite, database, add, drain } = fixture();
	sqlite.prepare("INSERT INTO media VALUES (?, ?)").run("m-photo", "photos/geo.jpg");
	add("photos", "photo-1", organizerPhoto("m-photo", "photos/geo.jpg", "clean"));
	add("posts", "post-1", { content: [{ _type: "image", asset: { _ref: "m-photo" } }] });
	await drain();
	assert.equal((await classifyMediaRead(read("photos/geo.jpg"), database)).access, "public");

	// Location review is reopened on the photo's draft revision.
	sqlite.prepare("INSERT INTO revisions (id, collection, entry_id, data) VALUES (?, ?, ?, ?)")
		.run("photo-1-draft", "photos", "photo-1", JSON.stringify(organizerPhoto("m-photo", "photos/geo.jpg", "required")));
	sqlite.prepare("UPDATE ec_photos SET draft_revision_id = ? WHERE id = ?").run("photo-1-draft", "photo-1");
	let dirtyCalls = 0;
	assert.equal((await classifyMediaRead(read("photos/geo.jpg"), database, {
		onIndexDirty: () => { dirtyCalls += 1; },
	})).access, "denied");
	assert.equal(dirtyCalls, 1);
	await drain();
	assert.equal(await mediaAccessFromIndex(database, "photos/geo.jpg"), "denied");

	// Reviewed again: allowed once more.
	sqlite.prepare("UPDATE revisions SET data = ? WHERE id = ?")
		.run(JSON.stringify(organizerPhoto("m-photo", "photos/geo.jpg", "kept")), "photo-1-draft");
	assert.equal((await classifyMediaRead(read("photos/geo.jpg"), database)).access, "public");
	await drain();
	assert.equal(await mediaAccessFromIndex(database, "photos/geo.jpg"), "public");
});

test("a newly uploaded unreviewed photo is never public, even through a published post", async () => {
	const { sqlite, database, add, drain } = fixture();
	sqlite.prepare("INSERT INTO media VALUES (?, ?)").run("m-new", "photos/new.jpg");
	add("posts", "post-1", { featured_image: { id: "m-new" } });
	await drain();
	assert.equal(await mediaAccessFromIndex(database, "photos/new.jpg"), "public");
	add("photos", "photo-new", organizerPhoto("m-new", "photos/new.jpg", "required"), { status: "draft" });
	assert.equal((await classifyMediaRead(read("photos/new.jpg"), database)).access, "denied");
	await drain();
	assert.equal(await mediaAccessFromIndex(database, "photos/new.jpg"), "denied");
});

test("unpublishing, trashing, deleting, and editing revoke immediately; publishing allows", async () => {
	const { sqlite, database, add, drain } = fixture();
	for (const [id, key] of [["m-a", "a.jpg"], ["m-b", "b.jpg"], ["m-c", "c.jpg"], ["m-d", "d.jpg"], ["m-e", "e.jpg"]]) {
		sqlite.prepare("INSERT INTO media VALUES (?, ?)").run(id, key);
	}
	add("posts", "unpublish", { featured_image: { id: "m-a" } });
	add("pages", "trash", { content: [{ _type: "file", url: "/_emdash/api/media/file/b.jpg" }] });
	add("albums", "delete", { cover_image: { src: "https://photos.kanouk.com/_emdash/api/media/file/c.jpg" } });
	add("posts", "edit", { content: [{ _type: "htmlBlock", html: '<img src="d.jpg">' }] });
	add("posts", "publish-later", { featured_image: { id: "m-e" } }, { status: "draft" });
	await drain();
	for (const key of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) {
		assert.equal(await mediaAccessFromIndex(database, key), "public", key);
	}
	assert.equal(await mediaAccessFromIndex(database, "e.jpg"), "denied");

	sqlite.prepare("UPDATE ec_posts SET status = 'draft' WHERE id = 'unpublish'").run();
	sqlite.prepare("UPDATE ec_pages SET deleted_at = '2026-11-26' WHERE id = 'trash'").run();
	sqlite.prepare("DELETE FROM ec_albums WHERE id = 'delete'").run();
	sqlite.prepare("UPDATE revisions SET data = ? WHERE id = 'edit-live'").run(JSON.stringify({ content: [] }));
	sqlite.prepare("UPDATE ec_posts SET status = 'published' WHERE id = 'publish-later'").run();
	for (const key of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) {
		assert.equal(await mediaAccessFromIndex(database, key), "dirty", key);
		assert.equal((await classifyMediaRead(read(key), database)).access, "denied", key);
	}
	assert.equal((await classifyMediaRead(read("e.jpg"), database)).access, "public");
	await drain();
	for (const key of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) {
		assert.equal(await mediaAccessFromIndex(database, key), "denied", key);
	}
	assert.equal(await mediaAccessFromIndex(database, "e.jpg"), "public");
});

test("a write during a drain is never overwritten by the older state", async () => {
	const { sqlite, add, drain } = fixture();
	sqlite.prepare("INSERT INTO media VALUES (?, ?)").run("m-race", "race.jpg");
	add("posts", "race", { featured_image: { id: "m-race" } });
	await drain();
	sqlite.prepare("UPDATE ec_posts SET status = 'published', live_revision_id = 'race-live' WHERE id = 'race'").run();
	sqlite.prepare("UPDATE revisions SET data = ? WHERE id = 'race-live'").run(JSON.stringify({ featured_image: { id: "m-race" }, v: 2 }));
	// The drain reads the published state, then the post is unpublished before
	// its batch commits.
	const racing = d1(sqlite);
	const batch = racing.batch.bind(racing);
	racing.batch = async (statements) => {
		sqlite.prepare("UPDATE ec_posts SET status = 'draft' WHERE id = 'race'").run();
		return batch(statements);
	};
	await drainRefIndex(racing);
	const database = d1(sqlite);
	assert.equal(await mediaAccessFromIndex(database, "race.jpg"), "dirty");
	assert.equal((await classifyMediaRead(read("race.jpg"), database)).access, "denied");
	await drain();
	assert.equal(await mediaAccessFromIndex(database, "race.jpg"), "denied");
});

test("without the index tables the guard falls back to the full check", async () => {
	const { sqlite, database, add } = fixture();
	sqlite.exec(REF_INDEX_DOWN);
	sqlite.prepare("INSERT INTO media VALUES (?, ?)").run("m1", "x.jpg");
	add("posts", "p1", { featured_image: { id: "m1" } });
	let dirtyCalls = 0;
	const onIndexDirty = () => { dirtyCalls += 1; };
	assert.equal((await classifyMediaRead(read("x.jpg"), database, { onIndexDirty })).access, "public");
	assert.equal((await classifyMediaRead(read("y.jpg"), database, { onIndexDirty })).access, "denied");
	assert.equal(dirtyCalls, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name LIKE 'kanouk_ref_%'").get().c, 0);
});

test("URL and html references match exactly the forms the full check accepts", () => {
	assert.deepEqual(mediaUrlRefs("/_emdash/api/media/file/a%2Fb.jpg"), [["media:key", "a%2Fb.jpg"], ["media:enc", "a%2Fb.jpg"]]);
	assert.deepEqual(mediaUrlRefs("https://blog.kanouk.com/_emdash/api/media/file/a%2Fb.jpg"), [["media:enc", "a%2Fb.jpg"]]);
	assert.deepEqual(mediaUrlRefs("https://example.com/_emdash/api/media/file/a.jpg"), [["media:key", "https://example.com/_emdash/api/media/file/a.jpg"]]);
	assert.deepEqual(mediaUrlRefs(42), []);
	assert.deepEqual(htmlSrcValues(`<img src="a.jpg"><img data-src='b.jpg'> src= "c.jpg" <img src="d.jpg`), ["a.jpg", "b.jpg"]);
	assert.deepEqual(entryRefs("posts", { status: "draft", deleted_at: null, live_data: JSON.stringify({ featured_image: { id: "m" } }) }), []);
	assert.deepEqual(entryRefs("options", { value: JSON.stringify({ defaultOgImage: { mediaId: "og" } }) }), [["media:id", "og"]]);
	assert.deepEqual(entryRefs("options", null), []);
});

test("indexed album and photo-link queries return the same rows as the full scans", async () => {
	const { sqlite, database, add, drain } = fixture();
	add("albums", "album-1", { source_url: "https://kanolog.smugmug.com/Kyoto/" }, { slug: "kyoto" });
	add("albums", "album-2", { source_url: "https://kanolog.smugmug.com/Nara" }, { slug: "nara" });
	add("albums", "album-draft", {}, { status: "draft" });
	add("photos", "photo-1", { image: { id: "m1" }, album: "album-1" });
	add("photos", "photo-2", { image: { id: "m2" }, album: "album-2" });
	add("photos", "photo-2b", { image: { id: "m2" }, album: "album-1" });
	add("photos", "photo-3", { image: { id: "m3" }, album: "album-draft" });
	add("photos", "photo-4", { image: { id: "m4" }, album: "album-1" }, { status: "draft" });
	add("photos", "photo-5", { image: { id: "m5" }, album: "album-1" }, { deletedAt: "2026-01-01" });
	const album = { _type: "yohaku.album", id: "album-1" };
	add("posts", "related", { title: "related", content: [], related_album: "album-1" }, { publishedAt: "2026-09-05" });
	add("posts", "block", { title: "block", content: [album] }, { publishedAt: "2026-09-04" });
	add("posts", "slug-link", { title: "slug", content: [{ _type: "block", markDefs: [{ _type: "link", href: "https://photos.kanouk.com/albums/kyoto/" }] }] });
	add("posts", "source-link", { title: "source", content: [{ _type: "yohaku.linkCard", id: "https://kanolog.smugmug.com/Kyoto" }] });
	add("posts", "source-link-exact", { title: "source exact", content: [{ _type: "yohaku.linkCard", url: "https://kanolog.smugmug.com/Kyoto/" }] });
	add("posts", "id-link", { title: "id", content: [{ nested: { deeper: [{ url: "https://photos.kanouk.com/albums/album-1" }] } }] });
	add("posts", "draft", { title: "draft", content: [album] }, { status: "draft" });
	add("posts", "english", { title: "english", content: [album] }, { locale: "en" });
	add("posts", "other", { title: "other", content: [{ ...album, id: "album-2" }] });
	add("posts", "none", { title: "none", content: [{ _type: "block", text: "album-1" }] });
	await drain();

	for (const [albumId, locale] of [["album-1", "ja"], ["album-1", "en"], ["album-2", "ja"], ["album-draft", "ja"], ["missing", "ja"]]) {
		const full = sqlite.prepare(ALBUM_ARTICLES_QUERY).all(albumId, locale);
		const indexed = sqlite.prepare(INDEXED_ALBUM_ARTICLES_QUERY).all(albumId, locale);
		assert.deepEqual(indexed, full, `${albumId} ${locale}`);
	}
	assert.deepEqual(
		sqlite.prepare(ALBUM_ARTICLES_QUERY).all("album-1", "ja").map((row) => row.id).sort(),
		["block", "id-link", "related", "slug-link", "source-link-exact"],
	);

	const ids = JSON.stringify(["m1", "m2", "m3", "m4", "m5", "m-none"]);
	const sortRows = (rows) => rows.map((row) => `${row.id}:${row.media_id}`).sort();
	assert.deepEqual(sortRows(sqlite.prepare(INDEXED_ARTICLE_PHOTO_LINKS_QUERY).all(ids)), sortRows(sqlite.prepare(ARTICLE_PHOTO_LINKS_QUERY).all(ids)));
	assert.deepEqual(sortRows(sqlite.prepare(ARTICLE_PHOTO_LINKS_QUERY).all(ids)), ["photo-1:m1", "photo-2:m2", "photo-2b:m2"]);
	assert.ok(database);
});
