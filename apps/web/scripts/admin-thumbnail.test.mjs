import assert from "node:assert/strict";
import { test } from "node:test";
import { adminThumbnailRequest } from "../src/utils/admin-thumbnail.mjs";

const origin = "https://blog.kanouk.com";
const request = (href, w = "400", f = "webp") =>
	new URL(`/_image?${new URLSearchParams({ href, w, f })}`, origin);

test("maps the media library thumbnail onto a stored preview width", () => {
	assert.deepEqual(adminThumbnailRequest(request(`${origin}/_emdash/api/media/file/01ABC.01DEF.jpg`)), { encodedKey: "01ABC.01DEF.jpg", width: 480, format: "webp" });
	assert.deepEqual(adminThumbnailRequest(request(`${origin}/_emdash/api/media/file/a.jpg?v=hash`, "80")), { encodedKey: "a.jpg", width: 320, format: "webp" });
	assert.equal(adminThumbnailRequest(request(`${origin}/_emdash/api/media/file/a.jpg`, "4000"))?.width, 1600);
});

test("leaves other images and other origins to the default handler", () => {
	assert.equal(adminThumbnailRequest(request("https://example.com/_emdash/api/media/file/a.jpg")), null);
	assert.equal(adminThumbnailRequest(request(`${origin}/photo.jpg`)), null);
	assert.equal(adminThumbnailRequest(request(`${origin}/_emdash/api/media/file/backups/x/a.jpg`)), null);
	assert.equal(adminThumbnailRequest(new URL("/_images/a.jpg", origin)), null);
});
