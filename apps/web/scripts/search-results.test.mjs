import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	normalizeSearchSort,
	searchCountLabel,
	snippetRepeatsTitle,
	snippetText,
	sortSearchResults,
} from "../src/utils/search-results.mjs";
import { isPhotoHost } from "../src/utils/site-host.mjs";

describe("snippetRepeatsTitle", () => {
	test("detects a snippet that is only the highlighted title", () => {
		assert.equal(snippetRepeatsTitle("<mark>京都</mark>旅行 2022年4月", "京都旅行 2022年4月"), true);
	});
	test("ignores whitespace differences and entities", () => {
		assert.equal(snippetRepeatsTitle("A &amp;  B\n", " A & B "), true);
	});
	test("keeps a snippet with more words than the title", () => {
		assert.equal(snippetRepeatsTitle("<mark>京都</mark>旅行 2022年4月 に行きました", "京都旅行 2022年4月"), false);
	});
	test("treats a missing or empty snippet as nothing to show", () => {
		assert.equal(snippetRepeatsTitle(undefined, "題"), true);
		assert.equal(snippetRepeatsTitle("<mark></mark>", "題"), true);
	});
	test("snippetText strips tags", () => {
		assert.equal(snippetText("a <mark>b</mark> c"), "a b c");
	});
});

describe("sortSearchResults", () => {
	const items = [
		{ id: "a", date: new Date("2010-01-01") },
		{ id: "b" },
		{ id: "c", date: new Date("2024-05-01") },
		{ id: "d", date: new Date("2010-01-01") },
	];
	test("relevance keeps the original order", () => {
		assert.deepEqual(sortSearchResults(items, "relevance").map((i) => i.id), ["a", "b", "c", "d"]);
	});
	test("new puts the newest first, undated last, ties stable", () => {
		assert.deepEqual(sortSearchResults(items, "new").map((i) => i.id), ["c", "a", "d", "b"]);
	});
	test("does not mutate the input", () => {
		sortSearchResults(items, "new");
		assert.equal(items[0].id, "a");
	});
	test("unknown sort values fall back to relevance", () => {
		assert.equal(normalizeSearchSort("x"), "relevance");
		assert.equal(normalizeSearchSort("new"), "new");
	});
});

describe("searchCountLabel", () => {
	test("says 以上 when the cap was reached", () => {
		assert.equal(searchCountLabel(30, 30), "30件以上");
		assert.equal(searchCountLabel(7, 30), "7件");
	});
});

describe("isPhotoHost", () => {
	test("matches only the photo hosts", () => {
		assert.equal(isPhotoHost("photos.kanouk.com"), true);
		assert.equal(isPhotoHost("photos-staging.kanouk.com"), true);
		assert.equal(isPhotoHost("blog.kanouk.com"), false);
		assert.equal(isPhotoHost("localhost"), false);
	});
});
