import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

const { postCoverImages } = await import("../src/utils/post-covers.ts");

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE ec_albums (id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at TEXT, live_revision_id TEXT);
	`);
	let queries = 0;
	const connection = {
		async executeQuery({ sql, parameters }) {
			queries += 1;
			return { rows: sqlite.prepare(sql).all(...parameters) };
		},
		async *streamQuery() {},
	};
	const db = new Kysely({
		dialect: {
			createAdapter: () => new SqliteAdapter(),
			createQueryCompiler: () => new SqliteQueryCompiler(),
			createIntrospector: (kysely) => new SqliteIntrospector(kysely),
			createDriver: () => ({
				init: async () => {},
				acquireConnection: async () => connection,
				beginTransaction: async () => {},
				commitTransaction: async () => {},
				rollbackTransaction: async () => {},
				releaseConnection: async () => {},
				destroy: async () => {},
			}),
		},
	});
	const addAlbum = (id, cover, status = "published", deletedAt = null) => {
		sqlite.prepare("INSERT INTO revisions VALUES (?, ?)").run(`${id}-live`, JSON.stringify({ cover_image: cover }));
		sqlite.prepare("INSERT INTO ec_albums VALUES (?, ?, ?, ?)").run(id, status, deletedAt, `${id}-live`);
	};
	return { db, addAlbum, queryCount: () => queries };
}

const post = (id, data) => ({ data: { id, ...data } });

test("a post's own cover wins and needs no album query", async () => {
	const { db, addAlbum, queryCount } = fixture();
	addAlbum("album", { id: "album-cover" });
	const own = { id: "own-cover" };
	const covers = await postCoverImages([post("p", { featured_image: own, related_album: "album" })], db);
	assert.deepEqual(covers.get("p"), own);
	assert.equal(queryCount(), 0);
});

test("posts without a cover use their album's cover, in one query", async () => {
	const { db, addAlbum, queryCount } = fixture();
	addAlbum("a", { id: "cover-a" });
	addAlbum("b", { id: "cover-b" });
	const covers = await postCoverImages([
		post("p1", { featured_image: null, related_album: "a" }),
		post("p2", { related_album: "a" }),
		post("p3", { featured_image: { id: "" }, related_album: "b" }),
	], db);
	assert.deepEqual(covers.get("p1"), { id: "cover-a" });
	assert.deepEqual(covers.get("p2"), { id: "cover-a" });
	assert.deepEqual(covers.get("p3"), { id: "cover-b" });
	assert.equal(queryCount(), 1);
});

test("private, deleted, coverless and missing albums supply nothing", async () => {
	const { db, addAlbum } = fixture();
	addAlbum("draft", { id: "cover" }, "draft");
	addAlbum("deleted", { id: "cover" }, "published", "2026-01-01");
	addAlbum("empty", null);
	const covers = await postCoverImages([
		post("p1", { related_album: "draft" }),
		post("p2", { related_album: "deleted" }),
		post("p3", { related_album: "empty" }),
		post("p4", { related_album: "missing" }),
		post("p5", {}),
	], db);
	assert.equal(covers.size, 0);
});
