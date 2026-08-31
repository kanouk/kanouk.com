import assert from "node:assert/strict";
import test from "node:test";
import { convertPostContent } from "./yohaku-transformers.mjs";

const context = {
	siteId: "test",
	reusableBlocks: new Map(),
	products: new Map([
		["42", { title: "Sample", primaryUrl: "https://example.test/item" }],
	]),
};

test("converts a theme balloon to semantic dialogue deterministically", () => {
	const post = {
		id: 1,
		content: '<!-- wp:loos/balloon {"balloonID":"7"} --><p>Hello</p><!-- /wp:loos/balloon -->',
	};
	const first = convertPostContent(post, context);
	const second = convertPostContent(post, context);
	assert.deepEqual(first, second);
	assert.equal(first[0]._type, "yohaku.dialogue");
	assert.equal(first[0].body, "Hello");
});

test("converts classic artwork metadata tables to portable tables", () => {
	const post = {
		id: 2,
		content: "<!-- wp:html --><table><tr><th>作者</th><td>Sample Artist</td></tr></table><!-- /wp:html -->",
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "table");
	assert.equal(blocks[0].rows[0].cells[0].content[0].text, "作者");
	assert.equal(blocks[0].rows[0].cells[1].content[0].text, "Sample Artist");
});

test("resolves product records without retaining plugin block names", () => {
	const post = {
		id: 3,
		content: '<!-- wp:pochipp/linkbox {"pid":42} /-->',
	};
	const blocks = convertPostContent(post, context);
	assert.equal(blocks[0]._type, "yohaku.productCard");
	assert.equal(blocks[0].title, "Sample");
	assert.equal(blocks[0].id, "https://example.test/item");
});
