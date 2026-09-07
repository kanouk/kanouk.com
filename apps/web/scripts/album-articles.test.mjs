import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { relatedAlbumArticles } from "../src/utils/album-articles.mjs";

const d1Database = (db) => ({
	prepare: (sql) => ({
		bind: (...params) => ({
			all: async () => ({ results: db.prepare(sql).all(...params) }),
		}),
	}),
});

test("reverse links use explicit published revision album relations only", async () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE revisions (id TEXT, data TEXT);
		CREATE TABLE ec_posts (id TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT, locale TEXT, published_at TEXT);
		CREATE TABLE ec_albums (id TEXT, slug TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT);`);
		db.prepare("INSERT INTO revisions VALUES (?, ?)").run("album-live", JSON.stringify({ source_url: "https://kanolog.smugmug.com/Kyoto" }));
		db.prepare("INSERT INTO ec_albums VALUES (?, ?, ?, ?, ?)").run("album1", "kyoto", "album-live", "published", null);
		const add = (id, content, status = "published", deleted = null, locale = "ja", data = {}) => {
			db.prepare("INSERT INTO revisions VALUES (?, ?)").run(id, JSON.stringify({ title: id, content, ...data }));
			db.prepare("INSERT INTO ec_posts VALUES (?, ?, ?, ?, ?, ?)").run(id, id, status, deleted, locale, "2026-09-06");
		};
		const album = { _type: "yohaku.album", id: "album1" };
		add("configured", [], "published", null, "ja", { related_album: "album1" });
		add("configured-and-block", [album], "published", null, "ja", { related_album: "album1" });
		add("configured-draft", [], "draft", null, "ja", { related_album: "album1" });
		add("configured-deleted", [], "published", "2026-09-06", "ja", { related_album: "album1" });
		add("configured-other-locale", [], "published", null, "en", { related_album: "album1" });
		add("configured-other-album", [], "published", null, "ja", { related_album: "album2" });
		add("published", [album, album]);
		add("draft", [album], "draft");
		add("deleted", [album], "published", "2026-09-06");
		add("photo-only", [{ _type: "yohaku.photo", albumId: "album1", id: "photo1" }]);
		add("different-album", [{ ...album, id: "album2" }]);
		add("different-locale", [album], "published", null, "en");
		add("live-no-link", []);
		const closing = {
			_type: "block",
			children: [{ _type: "span", text: "写真は SmugMug で。", marks: [] }],
			markDefs: [],
		};
		add("legacy-pair", [closing, { _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/kyoto" }]);
		add("legacy-draft", [closing, { _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/kyoto" }], "draft");
		add("legacy-deleted", [closing, { _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/kyoto" }], "published", "2026-09-06");
		add("legacy-other-locale", [closing, { _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/kyoto" }], "published", null, "en");
		add("legacy-inline", [{
			...closing,
			children: [
				{ _type: "span", text: "写真は", marks: [] },
				{ _type: "span", text: "SmugMug", marks: ["album-link"] },
				{ _type: "span", text: "で。", marks: [] },
			],
			markDefs: [{ _type: "link", _key: "album-link", href: "https://photos.kanouk.com/albums/kyoto" }],
		}]);
		add("standalone-card", [{ _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/kyoto" }]);
		add("meaningful-prose", [{
			...closing,
			children: [{ _type: "span", text: "旅の写真はSmugMugで公開しています。", marks: ["album-link"] }],
			markDefs: [{ _type: "link", _key: "album-link", href: "https://photos.kanouk.com/albums/kyoto" }],
		}]);
		add("unresolved-pair", [closing, { _type: "yohaku.linkCard", id: "https://photos.kanouk.com/albums/other" }]);
		// A separate draft revision adding the album must not leak into live output.
		db.prepare("INSERT INTO revisions VALUES (?, ?)").run("draft-change", JSON.stringify({ title: "draft title", content: [album] }));
		db.prepare("INSERT INTO revisions VALUES (?, ?)").run("draft-setting-change", JSON.stringify({ title: "draft title", content: [], related_album: "album1" }));
		const rows = await relatedAlbumArticles(d1Database(db), "album1", "ja");
		assert.deepEqual(rows, [
			{ id: "configured", title: "configured" },
			{ id: "configured-and-block", title: "configured-and-block" },
			{ id: "legacy-inline", title: "legacy-inline" },
			{ id: "legacy-pair", title: "legacy-pair" },
			{ id: "published", title: "published" },
		]);
	} finally { db.close(); }
});

test("an ambiguous published legacy source URL does not establish a reverse link", async () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE revisions (id TEXT, data TEXT);
		CREATE TABLE ec_posts (id TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT, locale TEXT, published_at TEXT);
		CREATE TABLE ec_albums (id TEXT, slug TEXT, live_revision_id TEXT, status TEXT, deleted_at TEXT);`);
		for (const [id, slug, revision] of [["album1", "kyoto", "album-live"], ["album2", "other", "other-live"]]) {
			db.prepare("INSERT INTO revisions VALUES (?, ?)").run(revision, JSON.stringify({ source_url: "https://kanolog.smugmug.com/Kyoto" }));
			db.prepare("INSERT INTO ec_albums VALUES (?, ?, ?, ?, ?)").run(id, slug, revision, "published", null);
		}
		const closing = { _type: "block", children: [{ _type: "span", text: "写真はSmugMugで。", marks: [] }], markDefs: [] };
		const legacy = [closing, { _type: "yohaku.linkCard", id: "https://kanolog.smugmug.com/Kyoto" }];
		db.prepare("INSERT INTO revisions VALUES (?, ?)").run("legacy", JSON.stringify({ title: "legacy", content: legacy }));
		db.prepare("INSERT INTO ec_posts VALUES (?, ?, ?, ?, ?, ?)").run("legacy", "legacy", "published", null, "ja", "2026-09-06");
		assert.deepEqual(await relatedAlbumArticles(d1Database(db), "album1", "ja"), []);
	} finally { db.close(); }
});
