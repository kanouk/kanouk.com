import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { d1 } from "./d1-fixture.mjs";
import { changeGeneration, stampedMemo, STAMPED_TTL_SECONDS } from "../src/utils/change-gen.mjs";
import { clearEdgeMemo } from "../src/utils/edge-memo.mjs";

const UP = readFileSync(new URL("../migrations/kanouk/0002_change_gen.up.sql", import.meta.url), "utf8");
const DOWN = readFileSync(new URL("../migrations/kanouk/0002_change_gen.down.sql", import.meta.url), "utf8");

function fixture({ migrate = true } = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE taxonomies (id TEXT PRIMARY KEY, name TEXT, slug TEXT, label TEXT, translation_group TEXT, locale TEXT);
		CREATE TABLE content_taxonomies (collection TEXT, entry_id TEXT, taxonomy_id TEXT, PRIMARY KEY (collection, entry_id, taxonomy_id));
		CREATE TABLE _emdash_taxonomy_defs (id TEXT PRIMARY KEY, name TEXT, collections TEXT);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, deleted_at TEXT, translation_group TEXT, locale TEXT, published_at TEXT, draft_revision_id TEXT);
		CREATE TABLE ec_photos (id TEXT PRIMARY KEY, album TEXT, status TEXT, deleted_at TEXT, position REAL);
		INSERT INTO ec_posts VALUES ('p1', 'one', 'published', NULL, 'p1', 'ja', '2026-01-01', NULL);
		INSERT INTO taxonomies VALUES ('t1', 'tag', 'a', 'A', 't1', 'ja');
	`);
	if (migrate) sqlite.exec(UP);
	return { sqlite, db: d1(sqlite) };
}

test("the terms stamp turns over on every change that can move a term list or its counts", async () => {
	const { sqlite, db } = fixture();
	const changes = [
		"INSERT INTO content_taxonomies VALUES ('posts', 'p1', 't1')",
		"DELETE FROM content_taxonomies",
		"UPDATE taxonomies SET label = 'B'",
		"INSERT INTO taxonomies VALUES ('t2', 'tag', 'c', 'C', 't2', 'ja')",
		"DELETE FROM taxonomies WHERE id = 't2'",
		"UPDATE ec_posts SET status = 'draft'",
		"UPDATE ec_posts SET status = 'published'",
		"UPDATE ec_posts SET deleted_at = 'now'",
		"UPDATE ec_posts SET locale = 'en'",
		"INSERT INTO ec_posts VALUES ('p2', 'two', 'draft', NULL, 'p2', 'ja', NULL, NULL)",
		"DELETE FROM ec_posts WHERE id = 'p2'",
		"INSERT INTO _emdash_taxonomy_defs VALUES ('d1', 'tag', '[\"posts\"]')",
	];
	let before = await changeGeneration(db, "terms");
	assert.match(before, /^[0-9a-f]{16}$/);
	for (const change of changes) {
		sqlite.exec(change);
		const after = await changeGeneration(db, "terms");
		assert.notEqual(after, before, change);
		before = after;
	}
	// Edits that cannot change counts keep the cache.
	sqlite.exec("UPDATE ec_posts SET title = 'edited', published_at = '2026-02-02', draft_revision_id = 'r9'");
	assert.equal(await changeGeneration(db, "terms"), before);
});

test("stampedMemo loads once per stamp and reloads right after a change", async () => {
	const { sqlite, db } = fixture();
	clearEdgeMemo();
	let loads = 0;
	const load = async () => [++loads];
	assert.deepEqual(await stampedMemo(db, "terms", "k", load), [1]);
	assert.deepEqual(await stampedMemo(db, "terms", "k", load), [1]);
	sqlite.exec("INSERT INTO content_taxonomies VALUES ('posts', 'p1', 't1')");
	assert.deepEqual(await stampedMemo(db, "terms", "k", load), [2]);
	assert.ok(STAMPED_TTL_SECONDS >= 3600);
});

test("without the table the value falls back to the short time-based cache", async () => {
	const { db } = fixture({ migrate: false });
	clearEdgeMemo();
	assert.equal(await changeGeneration(db, "terms"), null);
	assert.equal(await changeGeneration(undefined, "terms"), null);
	let loads = 0;
	assert.deepEqual(await stampedMemo(db, "terms", "k2", async () => [++loads]), [1]);
	assert.deepEqual(await stampedMemo(db, "terms", "k2", async () => [++loads]), [1]);
});

test("album reads use the album index, and the down migration removes everything", () => {
	const { sqlite } = fixture();
	const plan = (sql) => sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("a").map((row) => row.detail).join(" | ");
	assert.match(plan("SELECT id FROM ec_photos WHERE status = 'published' AND deleted_at IS NULL AND album = ?1"), /kanouk_ec_photos_album/);
	assert.match(plan("SELECT id FROM ec_photos p WHERE p.album = ?1 AND p.status = 'published' AND p.deleted_at IS NULL"), /kanouk_ec_photos_album/);
	sqlite.exec(DOWN);
	const left = sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'kanouk_%'").all();
	assert.deepEqual(left, []);
	sqlite.exec("INSERT INTO content_taxonomies VALUES ('posts', 'p1', 't1')");
	sqlite.exec(UP);
	sqlite.exec(UP); // idempotent
});
