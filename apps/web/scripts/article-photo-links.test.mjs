import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ARTICLE_PHOTO_LINKS_QUERY, articlePhotoLinks } from "../src/utils/article-photo-links.mjs";

test("legacy image links resolve only unambiguous published photo+album pairs", async () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE revisions (id TEXT, data TEXT);
		CREATE TABLE ec_photos (id TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT);
		CREATE TABLE ec_albums (id TEXT, status TEXT, deleted_at TEXT);
		INSERT INTO ec_albums VALUES ('album', 'published', NULL), ('draft-album', 'draft', NULL);`);
		const add = (id, mediaId, album = "album", status = "published") => {
			db.prepare("INSERT INTO revisions VALUES (?, ?)").run(id, JSON.stringify({ image: { id: mediaId }, album }));
			db.prepare("INSERT INTO ec_photos VALUES (?, ?, ?, NULL)").run(id, id, status);
		};
		add("photo1", "media1"); add("photo2", "media2"); add("photo3", "media2");
		add("private", "media3", "album", "draft"); add("private-album", "media4", "draft-album");
		const fakeD1 = { prepare(sql) { assert.equal(sql, ARTICLE_PHOTO_LINKS_QUERY); return { bind(...args) { return { async all() { return { results: db.prepare(sql).all(...args) }; } }; } }; } };
		const content = ["media1", "media2", "media3", "media4", "missing"].map(id => ({ _type: "image", asset: { _ref: id } }));
		assert.deepEqual([...await articlePhotoLinks(fakeD1, content)], [["media1", "photo1"]]);
		assert.equal((await articlePhotoLinks(fakeD1, [])).size, 0);
	} finally { db.close(); }
});
