import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lightboxLinkLabel } from "../src/utils/image-lightbox-link.mjs";

const BLOG = "https://blog.kanouk.com";
const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("the link label says where a linked image leads", () => {
	assert.equal(lightboxLinkLabel("https://photos.kanouk.com/p/abc", BLOG), "カノログ フォト");
	assert.equal(lightboxLinkLabel("/p/abc", "http://localhost:4321"), "カノログ フォト");
	assert.equal(lightboxLinkLabel("https://photos.kanouk.com/albums/abc", BLOG), "リンク先を開く（photos.kanouk.com）");
	assert.equal(lightboxLinkLabel("http://www.amazon.co.jp/exec/obidos/ASIN/1", BLOG), "リンク先を開く（amazon.co.jp）");
	assert.equal(lightboxLinkLabel("/posts/abc", BLOG), "リンク先を開く");
	assert.equal(lightboxLinkLabel("https://example.test/p/abc", BLOG), "リンク先を開く（example.test）");
	assert.equal(lightboxLinkLabel("http://[bad", BLOG), "リンク先を開く");
});

test("every body image opens the lightbox and linked images stay real links", async () => {
	const [image, client] = await Promise.all([
		read("src/components/YohakuPortableImage.astro"),
		read("src/client/image-lightbox.ts"),
	]);
	assert.match(image, /<a href=\{link\.href\}[^>]*data-image-lightbox/);
	assert.match(image, /<button type="button"[^>]*data-image-lightbox/);
	assert.match(image, /import "\.\.\/client\/image-lightbox";/);
	assert.match(client, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
	assert.match(client, /showModal\(\)/);
});
