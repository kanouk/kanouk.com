import assert from "node:assert/strict";
import test from "node:test";

import {
	repairLinkCards,
	mergeSourceCards,
	portableTextExcerpt,
	publicFeaturedImage,
	renderedLinkCards,
	resolveSourceCard,
	sourceLinkCards,
	wxrContentById,
} from "./backfill-link-cards.mjs";

test("converts local and external featured images to public card URLs", () => {
	assert.equal(
		publicFeaturedImage({ id: "01MEDIA", provider: "local", meta: { storageKey: "01IMAGE.png" } }),
		"/_emdash/api/media/file/01IMAGE.png",
	);
	assert.equal(
		publicFeaturedImage({ id: "", provider: "external", src: "https://example.com/cover.jpg" }),
		"https://example.com/cover.jpg",
	);
	assert.equal(publicFeaturedImage(undefined), undefined);
});

test("builds a concise preview from portable text paragraphs", () => {
	assert.equal(portableTextExcerpt([
		{ _type: "block", children: [{ _type: "span", text: "前から気になっていた" }] },
		{ _type: "yohaku.linkCard", title: "カード名" },
		{ _type: "block", children: [{ _type: "span", text: "Aesop の香水。" }] },
	]), "前から気になっていた Aesop の香水。");
});

test("extracts one requested WordPress item without taking neighboring content", () => {
	const xml = `<rss><channel><item><wp:post_id>1</wp:post_id><content:encoded><![CDATA[first]]></content:encoded></item><item><wp:post_id>2</wp:post_id><content:encoded><![CDATA[second]]></content:encoded></item></channel></rss>`;
	assert.deepEqual([...wxrContentById(xml, new Set(["2"]))], [["2", "second"]]);
});

test("extracts nested SWELL link data from source content", () => {
	const cards = sourceLinkCards(
		'<!-- wp:loos/post-link {"linkData":{"title":"Aesop Tacitを買ってみた","id":8790,"url":"https://kanolog.net/stream/8790","kind":"post-type","type":"post"},"icon":"link"} /-->',
		"kanolog",
		"8798",
	);
	assert.equal(cards[0].id, "wordpress://kanolog/post/8790");
	assert.equal(cards[0].title, "Aesop Tacitを買ってみた");
});

test("recovers cards from the rendered SWELL markup when source attributes are incomplete", () => {
	const html = `<div class="p-blogCard"><a class="p-blogCard__title" href="https://kanolog.net/stream/8790">Aesop Tacitを買ってみた</a></div>`;
	assert.deepEqual(renderedLinkCards(html), [{
		_type: "yohaku.linkCard",
		id: "https://kanolog.net/stream/8790",
		title: "Aesop Tacitを買ってみた",
	}]);
	assert.equal(mergeSourceCards([{ title: "関連記事" }], renderedLinkCards(html))[0].id, "https://kanolog.net/stream/8790");
});

test("resolves an internal source card to a stable post URL and preview fields", () => {
	const targets = new Map([["kanolog:8790", {
		id: "01M1CRQFTCN2WEM2WR0ECJ01VB",
		title: "Aesop Tacitを買ってみた",
		excerpt: "Aesopの香水について。",
		featuredImage: "/_emdash/api/media/file/tacit.png",
	}]]);
	assert.deepEqual(resolveSourceCard({ id: "wordpress://kanolog/post/8790" }, targets), {
		href: "/posts/01M1CRQFTCN2WEM2WR0ECJ01VB",
		title: "Aesop Tacitを買ってみた",
		description: "Aesopの香水について。",
		imageUrl: "/_emdash/api/media/file/tacit.png",
		caption: "あわせて読みたい",
	});
});

test("repairs only an empty card and preserves a deliberately replaced destination", () => {
	const targets = new Map([["kanolog:8790", { id: "TARGET", title: "Aesop Tacitを買ってみた" }]]);
	const current = [
		{ _type: "yohaku.linkCard", _key: "empty", id: "", title: "関連記事" },
		{ _type: "yohaku.linkCard", _key: "replacement", id: "https://perfume.fm/perfumes/diptyque-orpheon" },
	];
	const source = [
		{ _type: "yohaku.linkCard", id: "wordpress://kanolog/post/8790", title: "Aesop Tacitを買ってみた" },
		{ _type: "yohaku.linkCard", id: "https://www.fragrantica.com/example" },
	];
	const result = repairLinkCards(current, source, targets);
	assert.equal(result.repairedDestinations, 1);
	assert.equal(result.value[0].id, "/posts/TARGET");
	assert.equal(result.value[0].title, "Aesop Tacitを買ってみた");
	assert.equal(result.value[1].id, "https://perfume.fm/perfumes/diptyque-orpheon");
});

test("replaces a mistaken media record URL with the storage-key URL", () => {
	const targets = new Map([["kanolog:8790", {
		id: "TARGET",
		title: "Aesop Tacitを買ってみた",
		featuredImage: "/_emdash/api/media/file/STORAGE.png",
	}]]);
	const result = repairLinkCards(
		[{ _type: "yohaku.linkCard", id: "/posts/TARGET", imageUrl: "/_emdash/api/media/file/01M1DEAQK6X29C5BD8QQDH12VK" }],
		[{ _type: "yohaku.linkCard", id: "wordpress://kanolog/post/8790" }],
		targets,
	);
	assert.equal(result.value[0].imageUrl, "/_emdash/api/media/file/STORAGE.png");
});
