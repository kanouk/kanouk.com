import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "libsql";
import { normalizePhotoSort, photoOrderSql, sqlLiteral, sqlSortDirection, sqlSortMethod } from "../src/utils/photo-sort.mjs";

test("normalizes SmugMug's stored values and aliases", () => {
	assert.deepEqual(normalizePhotoSort("position", "asc"), { method: "position", direction: "asc" });
	assert.deepEqual(normalizePhotoSort("Date Taken", "DESC"), { method: "date taken", direction: "desc" });
	assert.deepEqual(normalizePhotoSort("Manually", null), { method: "position", direction: "asc" });
	assert.deepEqual(normalizePhotoSort(null, undefined), { method: "date taken", direction: "asc" });
	assert.deepEqual(normalizePhotoSort("random", "sideways"), { method: "date taken", direction: "asc" });
});

const db = new Database(":memory:");
db.exec(`CREATE TABLE p (id TEXT, captured INTEGER, position REAL, filename TEXT, caption TEXT, created TEXT, updated TEXT);
INSERT INTO p VALUES ('a', 300, 2, 'B.jpg', 'beta', '2026-01-02', '2026-01-05'),
 ('b', 100, 3, 'a.jpg', 'Alpha', '2026-01-03', '2026-01-04'),
 ('c', NULL, 1, 'c.jpg', 'gamma', '2026-01-01', '2026-01-06'),
 ('d', 200, 4, 'd.jpg', '', '2026-01-04', '2026-01-03');`);
const columns = { captured: "captured", position: "position", filename: "filename", caption: "caption", created: "created", updated: "updated", id: "id" };
const order = (method, direction) => {
	const sort = normalizePhotoSort(method, direction);
	return db.prepare(`SELECT id FROM p ORDER BY ${photoOrderSql(sqlLiteral(sort.method), sqlLiteral(sort.direction), columns)}`).all().map((row) => row.id).join("");
};

test("orders by capture time with undated photos last", () => {
	assert.equal(order("date taken", "asc"), "bdac");
	assert.equal(order("date taken", "desc"), "adbc");
});

test("manual order follows position, either way", () => {
	assert.equal(order("position", "asc"), "cabd");
	assert.equal(order("position", "desc"), "dbac");
});

test("other SmugMug sorts", () => {
	assert.equal(order("filename", "asc"), "bacd");
	assert.equal(order("caption", "asc"), "dbac");
	assert.equal(order("date uploaded", "desc"), "dbac");
	assert.equal(order("date modified", "asc"), "dbac");
});

test("the SQL normalizer agrees with the JavaScript one", () => {
	for (const value of ["position", "Manually", "date taken", "DateTaken", "", null, "nonsense", "file name"]) {
		const row = db.prepare(`SELECT ${sqlSortMethod("?")} AS m, ${sqlSortDirection("?")} AS d`).get(value, value);
		const expected = normalizePhotoSort(value, value);
		assert.equal(row.m, expected.method, String(value));
	}
	assert.equal(db.prepare(`SELECT ${sqlSortDirection("?")} AS d`).get("DESC").d, "desc");
});

test("the JavaScript comparator matches the SQL order", async () => {
	const { photoComparator } = await import("../src/utils/photo-sort.mjs");
	const rows = db.prepare("SELECT * FROM p").all().map((row) => ({
		id: row.id, createdAt: row.created, updatedAt: row.updated,
		data: { captured_at: row.captured === null ? null : new Date(row.captured * 1000).toISOString(), position: row.position, caption: row.caption, image: { filename: row.filename } },
	}));
	for (const [method, direction] of [["date taken", "asc"], ["date taken", "desc"], ["position", "asc"], ["position", "desc"], ["filename", "asc"], ["date uploaded", "desc"], ["date modified", "asc"]]) {
		assert.equal(rows.toSorted(photoComparator(method, direction)).map((row) => row.id).join(""), order(method, direction), `${method} ${direction}`);
	}
});
