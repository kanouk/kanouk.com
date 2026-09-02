import assert from "node:assert/strict";
import test from "node:test";

import {
	articleImageMapping,
	buildArticleImageIndex,
	repairArticleImages,
} from "./backfill-article-images.mjs";

function fixture() {
	const manifests = [{ assets: [{
		id: "kph-photo",
		display: { title: "アルバムの題名", caption: "アルバムの説明" },
		destination: {
			emdash_media_id: "01MEDIA",
			r2_object_key: "image.one.jpg",
			media_path: "/_emdash/api/media/file/image.one.jpg",
		},
	}] }];
	return buildArticleImageIndex(manifests);
}

test("matches migrated album images by media id or storage path", () => {
	const index = fixture();
	assert.equal(articleImageMapping({ asset: { _ref: "01MEDIA" } }, index).photoId, "kph-photo");
	assert.equal(articleImageMapping({ asset: { url: "/_emdash/api/media/file/image.one.jpg" } }, index).photoId, "kph-photo");
});

test("repairs only migrated album images while preserving an unrelated explicit link", () => {
	const index = fixture();
	const desired = new Map([["image-1", {
		displayWidth: 600,
		visualStyle: "photo-frame",
		caption: "記事のキャプション",
	}], ["photo:kph-photo", {
		displayWidth: 600,
		visualStyle: "photo-frame",
		caption: "記事のキャプション",
	}]]);
	const content = [
		{ _type: "image", _key: "image-1", asset: { _ref: "01MEDIA" }, displayWidth: 1024 },
		{ _type: "image", _key: "image-2", asset: { _ref: "01MEDIA" }, link: "https://example.com/story" },
		{ _type: "image", _key: "other", asset: { _ref: "OTHER" }, displayWidth: 1024 },
	];
	const result = repairArticleImages(content, desired, index);
	assert.equal(result.value[0].link, "https://photos.kanouk.com/p/kph-photo");
	assert.equal(result.value[0].displayWidth, 600);
	assert.equal(result.value[0].visualStyle, "photo-frame");
	assert.equal(result.value[0].caption, "記事のキャプション");
	assert.equal(result.value[1].link, "https://example.com/story");
	assert.equal(result.value[1].caption, "記事のキャプション");
	assert.equal(result.value[2].displayWidth, 1024);
	assert.equal(result.value[1].displayWidth, 600);
	assert.deepEqual(result.counts, { images: 2, links: 1, widths: 2, frames: 2, captions: 2 });
});
