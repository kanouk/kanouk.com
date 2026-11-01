import assert from "node:assert/strict";
import test from "node:test";
import { embedCode, embedSizes, embedStorageKey } from "../src/utils/photo-embed.mjs";

test("finds the stored file of an image", () => {
	assert.equal(embedStorageKey({ meta: { storageKey: "a.jpg" } }), "a.jpg");
	assert.equal(embedStorageKey({ src: "/_emdash/api/media/file/b%20c.jpg" }), "b c.jpg");
	assert.equal(embedStorageKey({ src: "https://example.com/d.jpg" }), undefined);
});

test("offers only sizes the photo can fill", () => {
	assert.deepEqual(embedSizes(1000).map((size) => size.width), [480, 768]);
	assert.deepEqual(embedSizes(200).map((size) => size.width), [480]);
	assert.deepEqual(embedSizes(undefined).map((size) => size.width), [480, 768, 1200, 1600]);
});

test("links a resized image, never the original, to the photo page", () => {
	const code = embedCode({ origin: "https://photos.kanouk.com", path: "/p/x", storageKey: "a b.jpg", size: 768, photoWidth: 4000, photoHeight: 3000, alt: "駅" });
	assert.equal(code, '<a href="https://photos.kanouk.com/p/x"><img src="https://photos.kanouk.com/_yohaku/media/preview-v2/768/webp/a%20b.jpg" width="768" height="576" alt="駅" loading="lazy" style="max-width:100%;height:auto"></a>');
	assert.doesNotMatch(code, /media\/file/);
});

test("escapes text that could break out of the code", () => {
	const code = embedCode({ origin: "https://x", path: "/p/x", storageKey: "a", size: 480, alt: '"><script>' });
	assert.doesNotMatch(code, /<script>/);
});

test("a small photo is not stretched", () => {
	assert.match(embedCode({ origin: "https://x", path: "/p/x", storageKey: "a", size: 480, photoWidth: 200, photoHeight: 100 }), /width="200" height="100"/);
});
