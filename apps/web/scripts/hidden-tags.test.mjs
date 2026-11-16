import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isHiddenTag, visibleTags } from "../src/utils/hidden-tags.mjs";

describe("hidden tags", () => {
	test("hides the housekeeping tag by label", () => {
		assert.equal(isHiddenTag({ slug: "anything", label: "一覧非表示" }), true);
	});

	test("hides it by a decoded or percent-encoded slug", () => {
		assert.equal(isHiddenTag({ slug: "一覧非表示", label: "" }), true);
		assert.equal(isHiddenTag({ slug: encodeURIComponent("一覧非表示").toLowerCase() }), true);
	});

	test("keeps ordinary tags, in order", () => {
		const tags = [
			{ slug: "books", label: "本・雑誌" },
			{ slug: "hidden", label: "一覧非表示" },
			{ slug: "%e9%9f%b3%e6%a5%bd", label: "音楽" },
		];
		assert.deepEqual(visibleTags(tags).map((tag) => tag.label), ["本・雑誌", "音楽"]);
	});

	test("tolerates missing input and malformed slugs", () => {
		assert.deepEqual(visibleTags(undefined), []);
		assert.equal(isHiddenTag(null), false);
		assert.equal(isHiddenTag({ slug: "%E0%A4%A", label: "x" }), false);
	});
});
