import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lightboxLinkLabel } from "../src/utils/image-lightbox-link.mjs";
import { lightboxNeighbours, needsScrollIntoView, swipeStep } from "../src/utils/image-lightbox-nav.mjs";

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

test("stepping stays inside the article's photos without wrapping", () => {
	assert.deepEqual(lightboxNeighbours(0, 1), { previous: null, next: null, counter: "" });
	assert.deepEqual(lightboxNeighbours(0, 3), { previous: null, next: 1, counter: "1 / 3" });
	assert.deepEqual(lightboxNeighbours(1, 3), { previous: 0, next: 2, counter: "2 / 3" });
	assert.deepEqual(lightboxNeighbours(2, 3), { previous: 1, next: null, counter: "3 / 3" });
	assert.deepEqual(lightboxNeighbours(-1, 3), { previous: null, next: null, counter: "" });
	assert.deepEqual(lightboxNeighbours(3, 3), { previous: null, next: null, counter: "" });
});

test("only a clear one-way horizontal swipe steps", () => {
	assert.equal(swipeStep(-80, 10), 1, "swiping left shows the next photo");
	assert.equal(swipeStep(80, -10), -1, "swiping right shows the previous photo");
	assert.equal(swipeStep(-20, 0), 0, "short moves stay taps");
	assert.equal(swipeStep(-80, 70), 0, "diagonal moves are not swipes");
	assert.equal(swipeStep(10, 200), 0, "vertical drags scroll");
	assert.equal(swipeStep(Number.NaN, 0), 0);
});

test("the last photo viewed is scrolled back only when it is out of view", () => {
	assert.equal(needsScrollIntoView(100, 500, 800), false);
	assert.equal(needsScrollIntoView(-300, 100, 800), false, "a quarter or more still showing counts as in view");
	assert.equal(needsScrollIntoView(-380, 20, 800), true);
	assert.equal(needsScrollIntoView(900, 1300, 800), true);
	assert.equal(needsScrollIntoView(-2000, -1600, 800), true);
	assert.equal(needsScrollIntoView(-500, 1500, 800), false, "a photo taller than the screen that fills it is in view");
	assert.equal(needsScrollIntoView(0, 0, 800), false);
});

test("the lightbox offers stepping, a translucent scrim and a paper mount", async () => {
	const [client, theme] = await Promise.all([read("src/client/image-lightbox.ts"), read("src/styles/theme.css")]);
	assert.match(client, /aria-label="前の写真"/);
	assert.match(client, /aria-label="次の写真"/);
	assert.match(client, /class="image-lightbox__counter" aria-live="polite"/);
	assert.match(client, /event\.key === "ArrowLeft"/);
	assert.match(client, /trigger\.focus\(\{ preventScroll: true \}\)/);
	const block = theme.slice(theme.indexOf(".image-lightbox {"), theme.indexOf("@media (prefers-reduced-motion: reduce) {\n\t.image-lightbox"));
	assert.match(block, /\.image-lightbox \{[^}]*background: rgb\(0 0 0 \/ 7\d%\)/);
	assert.doesNotMatch(block, /backdrop-filter|blur\(/);
	assert.match(block, /\.image-lightbox__photo \{[^}]*background: #fcfcfa/);
	assert.match(block, /\.image-lightbox__counter \{[^}]*tabular-nums/);
});
