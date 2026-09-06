import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyAlbumLink,
	inlineLegacyAlbumLinkHref,
	isExplicitSmugMugClosing,
	normalizeLegacyAlbumCards,
} from "../src/utils/legacy-album-cards.mjs";

const paragraph = (text, extra = {}) => ({
	_type: "block",
	_key: `p-${text}`,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "span", text, marks: [] }],
	...extra,
});

const linkCard = (id) => ({ _type: "yohaku.linkCard", _key: "card", id });

test("recognizes only bounded SmugMug closing copy", () => {
	for (const text of [
		"写真は SmugMug で。",
		"その他の写真はSmugMugで。",
		"そのほかの写真は SmugMug へ。",
		"写真は SmugMug で。（あまり残ってなかった）",
	]) assert.equal(isExplicitSmugMugClosing(paragraph(text)), true);
	for (const text of [
		"写真はこちら。",
		"旅の写真はSmugMugで公開しています。",
		"写真はSmugMugで。ほかの記録もあります。",
	]) assert.equal(isExplicitSmugMugClosing(paragraph(text)), false);
});

test("replaces an exact adjacent closing pair only after a published album resolves", async () => {
	const intro = paragraph("写真は SmugMug で。");
	const card = linkCard("https://photos.kanouk.com/albums/2008-02-taiwan");
	const result = await normalizeLegacyAlbumCards([intro, card], async () => "album-id");
	assert.deepEqual(result, {
		content: [{ _type: "yohaku.album", _key: "card", id: "album-id" }],
		converted: 1,
	});

	const unresolved = await normalizeLegacyAlbumCards([intro, card], async () => "");
	assert.deepEqual(unresolved.content, [intro, card]);
});

test("converts the production inline-link shape without treating prose as a relation", async () => {
	const inline = paragraph("", {
		_key: "inline",
		markDefs: [{ _type: "link", _key: "album-link", href: "https://photos.kanouk.com/albums/2026-03-fukuoka" }],
		children: [
			{ _type: "span", _key: "a", text: "写真は", marks: [] },
			{ _type: "span", _key: "b", text: "SmugMug", marks: ["album-link"] },
			{ _type: "span", _key: "c", text: "で。", marks: [] },
		],
	});
	assert.equal(inlineLegacyAlbumLinkHref(inline), "https://photos.kanouk.com/albums/2026-03-fukuoka");
	const result = await normalizeLegacyAlbumCards([inline], async () => "fukuoka-id");
	assert.deepEqual(result.content, [{ _type: "yohaku.album", _key: "inline", id: "fukuoka-id" }]);

	const meaningful = {
		...inline,
		children: [...inline.children, { _type: "span", _key: "d", text: "旅の記録です。", marks: [] }],
	};
	assert.equal(inlineLegacyAlbumLinkHref(meaningful), "");
	const unusedMark = { ...inline, children: inline.children.map((child) => ({ ...child, marks: [] })) };
	assert.equal(inlineLegacyAlbumLinkHref(unusedMark), "");
	const multipleLinks = {
		...inline,
		markDefs: [
			...inline.markDefs,
			{ _type: "link", _key: "second", href: "https://photos.kanouk.com/albums/other" },
		],
	};
	assert.equal(inlineLegacyAlbumLinkHref(multipleLinks), "");
});

test("accepts only exact current or legacy album URLs and leaves standalone cards alone", async () => {
	assert.deepEqual(classifyAlbumLink("https://photos.kanouk.com/albums/kyoto"), { kind: "current", key: "kyoto" });
	assert.deepEqual(classifyAlbumLink("https://kanolog.smugmug.com/20220505kyoto/"), {
		kind: "legacy",
		href: "https://kanolog.smugmug.com/20220505kyoto/",
	});
	assert.equal(classifyAlbumLink("https://kanolog.smugmug.com/Trip/i-abc/A"), null);
	assert.equal(classifyAlbumLink("https://photos.kanouk.com/albums/bad%ZZ"), null);
	assert.equal(classifyAlbumLink("https://user@photos.kanouk.com/albums/kyoto"), null);
	const standalone = linkCard("https://photos.kanouk.com/albums/kyoto");
	const result = await normalizeLegacyAlbumCards([standalone], async () => "album-id");
	assert.deepEqual(result.content, [standalone]);
});

test("preserves an exact pair when the resolver reports an ambiguous source", async () => {
	const intro = paragraph("写真はSmugMugで。");
	const card = linkCard("https://kanolog.smugmug.com/Kyoto");
	const result = await normalizeLegacyAlbumCards([intro, card], async () => "");
	assert.deepEqual(result.content, [intro, card]);
});
