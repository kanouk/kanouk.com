import assert from "node:assert/strict";
import { test } from "node:test";
import { albumPhotoAnchor, photoReturnKey, readPhotoReturn } from "../src/utils/photo-return.mjs";

test("album return restores only the same album's recent photo", () => {
	const raw = JSON.stringify({ albumId: "album1", photoId: "photo_1", savedAt: 1000 });
	assert.equal(readPhotoReturn(raw, "album1", 2000), "photo_1");
	assert.equal(readPhotoReturn(raw, "album2", 2000), null);
	assert.equal(readPhotoReturn(raw, "album1", 2000000), null);
	assert.equal(readPhotoReturn(raw, "album1", 999), null);
});

test("malformed storage cannot become navigation", () => {
	for (const raw of [null, "bad", "{}", JSON.stringify({ albumId: "a", photoId: "https://bad.example", savedAt: 1 })]) {
		assert.equal(readPhotoReturn(raw, "a", 2), null);
	}
	assert.equal(albumPhotoAnchor("id_1"), "photo-id_1");
	assert.equal(photoReturnKey("album1"), "yohaku:album-return:album1");
});
