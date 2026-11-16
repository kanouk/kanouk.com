import assert from "node:assert/strict";
import { test } from "node:test";
import { getPostExcerpt } from "../src/utils/reading-time.ts";

const body = (text) => [{ _type: "block", children: [{ _type: "span", text }] }];
const hasLoneSurrogate = (text) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

test("an emoji at the cut is kept whole, never split into a broken character", () => {
	// "あ" x 9 then an emoji: in UTF-16 units the emoji straddles position 10.
	const text = `${"あ".repeat(9)}😀${"い".repeat(20)}`;
	const excerpt = getPostExcerpt(undefined, body(text), 10);
	assert.equal(excerpt, `${"あ".repeat(9)}😀…`);
	assert.equal(hasLoneSurrogate(excerpt), false);
});

test("the limit counts characters, so text with emoji that fits is not cut", () => {
	const text = "京都😀旅行👓";
	assert.equal(getPostExcerpt(undefined, body(text), 6), text);
});

test("plain text keeps the previous behaviour", () => {
	assert.equal(getPostExcerpt(undefined, body("abcdef  "), 4), "abcd…");
	assert.equal(getPostExcerpt("  手書きの 抜粋  ", body("本文"), 2), "手書きの 抜粋");
	assert.equal(getPostExcerpt(undefined, [], 10), undefined);
});
