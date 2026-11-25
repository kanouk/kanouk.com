import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { d1 } from "./d1-fixture.mjs";
import { adjacentPostId } from "../src/utils/adjacent-post.mjs";

test("the pager picks the nearest published, untrashed post on each side", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE ec_posts (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT, published_at TEXT)");
	const add = (id, publishedAt, status = "published", deletedAt = null) =>
		sqlite.prepare("INSERT INTO ec_posts VALUES (?, ?, ?, ?)").run(id, status, deletedAt, publishedAt);
	add("oldest", "2024-01-01T00:00:00.000Z");
	add("older-a", "2024-02-01T00:00:00.000Z");
	add("older-b", "2024-02-01T00:00:00.000Z");
	add("older-draft", "2024-02-15T00:00:00.000Z", "draft");
	add("current", "2024-03-01T00:00:00.000Z");
	add("same-time", "2024-03-01T00:00:00.000Z");
	add("newer-trashed", "2024-03-15T00:00:00.000Z", "published", "2024-04-01");
	add("newer-a", "2024-04-01T00:00:00.000Z");
	add("newer-b", "2024-04-01T00:00:00.000Z");
	const database = d1(sqlite);
	assert.equal(await adjacentPostId(database, "2024-03-01T00:00:00.000Z", "older"), "older-b");
	assert.equal(await adjacentPostId(database, "2024-03-01T00:00:00.000Z", "newer"), "newer-a");
	assert.equal(await adjacentPostId(database, "2024-01-01T00:00:00.000Z", "older"), undefined);
	assert.equal(await adjacentPostId(database, "2024-04-01T00:00:00.000Z", "newer"), undefined);
});
