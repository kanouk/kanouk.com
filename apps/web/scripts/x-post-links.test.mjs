import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promoteStandaloneLinks, promoteXPostLinks } from "../src/utils/x-post-links.mjs";

const URL = "https://x.com/EmDashCMS/status/2122340920087490612";
const link = (href, text = href, key = "m0") => ({ span: { _type: "span", _key: `s-${key}`, text, marks: [key] }, def: { _type: "link", _key: key, href } });
const block = (children, markDefs = [], extra = {}) => ({ _type: "block", _key: "k1", style: "normal", children, markDefs, ...extra });
const span = (text) => ({ _type: "span", _key: `t${text.length}`, text });

describe("X post links", () => {
	test("a paragraph that is only the URL becomes the post", () => {
		const { span: s, def } = link(URL);
		const out = promoteXPostLinks([block([s], [def])]);
		assert.deepEqual(out.map((node) => node._type), ["embed"]);
		assert.equal(out[0].url, URL);
		assert.equal(out[0].provider, "twitter");
	});

	test("a URL on its own line splits the paragraph around it", () => {
		const { span: s, def } = link(URL);
		const out = promoteXPostLinks([block([span("更新した。\n\n"), s, span("\n続き")], [def])]);
		assert.deepEqual(out.map((node) => node._type), ["block", "embed", "block"]);
		assert.equal(out[0].children[0].text, "更新した。");
		assert.equal(out[2].children[0].text, "続き");
		assert.equal(new Set(out.map((node) => node._key)).size, 3);
	});

	test("a URL inside a sentence stays a link", () => {
		const { span: s, def } = link(URL);
		const input = [block([span("これは "), s, span(" を参照")], [def])];
		assert.deepEqual(promoteXPostLinks(input), input);
	});

	test("a worded link, other sites, lists and headings stay as they are", () => {
		const worded = link(URL, "この投稿");
		const other = link("https://example.com/a/status/1");
		const listed = link(URL);
		const input = [
			block([worded.span], [worded.def]),
			block([other.span], [other.def]),
			block([listed.span], [listed.def], { listItem: "bullet" }),
			block([listed.span], [listed.def], { style: "h2" }),
			{ _type: "image", _key: "i" },
		];
		assert.deepEqual(promoteXPostLinks(input), input);
	});

	test("old twitter.com URLs work, and missing input is empty", () => {
		const { span: s, def } = link("https://twitter.com/nima_owji/status/1823388838279922166");
		assert.equal(promoteXPostLinks([block([s], [def])])[0]._type, "embed");
		assert.deepEqual(promoteXPostLinks(undefined), []);
	});
});

describe("standalone links", () => {
	const CF = "https://blog.cloudflare.com/search-for-agents";

	test("a paragraph that is only a URL becomes a link card; X posts still embed", () => {
		const card = link(CF, CF, "c");
		const post = link(URL, URL, "x");
		const out = promoteStandaloneLinks([block([card.span], [card.def]), { ...block([post.span], [post.def]), _key: "k2" }]);
		assert.deepEqual(out.map((node) => node._type), ["yohaku.linkCard", "embed"]);
		assert.equal(out[0].id, CF);
		assert.equal(out[0]._key, "k1:c0");
		assert.equal(out[1].provider, "twitter");
	});

	test("the shown text may differ from the href only in URL normalisation", () => {
		const slash = link("https://example.com", "https://example.com/");
		const encoded = link("https://ja.wikipedia.org/wiki/%E3%83%AA%E3%83%83%E3%83%94%E3%83%B3%E3%82%B0", "https://ja.wikipedia.org/wiki/リッピング");
		assert.equal(promoteStandaloneLinks([block([slash.span], [slash.def])])[0]._type, "yohaku.linkCard");
		assert.equal(promoteStandaloneLinks([block([encoded.span], [encoded.def])])[0]._type, "yohaku.linkCard");
	});

	test("a URL on its own line splits the paragraph around the card", () => {
		const { span: s, def } = link(CF);
		const out = promoteStandaloneLinks([block([span("読んだ。\n"), s, span("\n続き")], [def])]);
		assert.deepEqual(out.map((node) => node._type), ["block", "yohaku.linkCard", "block"]);
	});

	test("worded links, links inside sentences, non-web links, lists and headings stay as they are", () => {
		const worded = link(CF, "Cloudflareの記事");
		const inline = link(CF);
		const mail = link("mailto:a@example.com", "mailto:a@example.com");
		const input = [
			block([worded.span], [worded.def]),
			block([span("これは "), inline.span, span(" を参照")], [inline.def]),
			block([mail.span], [mail.def]),
			block([inline.span], [inline.def], { listItem: "bullet" }),
			block([inline.span], [inline.def], { style: "h3" }),
		];
		assert.deepEqual(promoteStandaloneLinks(input), input);
	});
});
