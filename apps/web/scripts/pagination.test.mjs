import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pageWindow, rangeLabel, totalPages } from "../src/utils/pagination.mjs";

const show = (items) => items.map((i) => (i.type === "gap" ? "…" : String(i.page))).join(" ");

describe("totalPages", () => {
	test("rounds up and handles empty", () => {
		assert.equal(totalPages(1293, 24), 54);
		assert.equal(totalPages(24, 24), 1);
		assert.equal(totalPages(0, 24), 0);
	});
});

describe("pageWindow", () => {
	test("middle page shows first, neighbours and last with gaps", () => {
		assert.equal(show(pageWindow(5, 54)), "1 … 4 5 6 … 54");
	});
	test("first and last pages", () => {
		assert.equal(show(pageWindow(1, 54)), "1 2 … 54");
		assert.equal(show(pageWindow(54, 54)), "1 … 53 54");
	});
	test("a single hidden page is shown instead of an ellipsis", () => {
		assert.equal(show(pageWindow(4, 54)), "1 2 3 4 5 … 54");
		assert.equal(show(pageWindow(51, 54)), "1 … 50 51 52 53 54");
	});
	test("short lists show every page", () => {
		assert.equal(show(pageWindow(2, 3)), "1 2 3");
		assert.equal(show(pageWindow(1, 1)), "1");
	});
	test("clamps out of range pages and rejects empty lists", () => {
		assert.equal(show(pageWindow(99, 5)), "1 … 4 5");
		assert.deepEqual(pageWindow(1, 0), []);
	});
});

describe("rangeLabel", () => {
	test("total and range", () => {
		assert.equal(rangeLabel(1293, 1, 24, 24), "1,293件中 1〜24件");
		assert.equal(rangeLabel(1293, 54, 24, 21), "1,293件中 1,273〜1,293件");
	});
	test("single page shows only the total", () => {
		assert.equal(rangeLabel(5, 1, 24, 5), "5件");
	});
	test("a page past the end falls back to the total", () => {
		assert.equal(rangeLabel(30, 9, 24, 0), "30件");
	});
});
