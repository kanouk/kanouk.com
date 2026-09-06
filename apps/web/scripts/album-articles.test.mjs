import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ALBUM_ARTICLES_QUERY } from "../src/utils/album-articles.mjs";

test("reverse links use explicit published revision album relations only", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE revisions (id TEXT, data TEXT);
		CREATE TABLE ec_posts (id TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT, locale TEXT, published_at TEXT);`);
		const add = (id, content, status = "published", deleted = null, locale = "ja") => {
			db.prepare("INSERT INTO revisions VALUES (?, ?)").run(id, JSON.stringify({ title: id, content }));
			db.prepare("INSERT INTO ec_posts VALUES (?, ?, ?, ?, ?, ?)").run(id, id, status, deleted, locale, "2026-09-06");
		};
		const album = { _type: "yohaku.album", id: "album1" };
		add("published", [album, album]);
		add("draft", [album], "draft");
		add("deleted", [album], "published", "2026-09-06");
		add("photo-only", [{ _type: "yohaku.photo", albumId: "album1", id: "photo1" }]);
		add("different-album", [{ ...album, id: "album2" }]);
		add("different-locale", [album], "published", null, "en");
		add("live-no-link", []);
		// A separate draft revision adding the album must not leak into live output.
		db.prepare("INSERT INTO revisions VALUES (?, ?)").run("draft-change", JSON.stringify({ title: "draft title", content: [album] }));
		const rows = db.prepare(ALBUM_ARTICLES_QUERY).all("album1", "ja");
		assert.deepEqual(rows.map(row => ({ ...row })), [{ id: "published", title: "published" }]);
	} finally { db.close(); }
});
