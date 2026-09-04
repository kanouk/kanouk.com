import assert from "node:assert/strict";
import test from "node:test";

const domain = await import("../src/studio/domain.ts");

test("review flags expose missing fields, location metadata, broken references and draft state", () => {
	const flags = domain.photoReviewFlags({
		caption: "",
		alt: "",
		image: { id: "missing" },
		source_metadata: { exif: { GPSLatitude: 35.6 } },
	}, { status: "draft", knownMediaIds: new Set(["present"]) });
	assert.deepEqual(flags, ["missing-caption", "missing-alt", "has-location", "broken-media", "unpublished"]);
});

test("bulk text modes preserve unspecified fields", () => {
	const original = { title: "Photo", caption: "existing", alt: "old", album: "album-a" };
	assert.deepEqual(domain.applyBulkPatch(original, {
		caption: { value: "prefix: ", mode: "prepend" },
		alt: { value: " appended", mode: "append" },
	}), { title: "Photo", caption: "prefix:existing", alt: "oldappended", album: "album-a" });
});

test("album positions are sparse and deterministic", () => {
	assert.deepEqual(domain.sparsePositions(4), [1024, 2048, 3072, 4096]);
});

test("duplicate candidates require a non-empty shared identity", () => {
	const items = [{ sha: "a" }, { sha: "" }, { sha: "a" }, { sha: "b" }];
	assert.deepEqual(domain.duplicateGroups(items, (item) => item.sha), [[items[0], items[2]]]);
});

test("handoff return paths reject cross-origin and protocol-relative values", () => {
	assert.equal(domain.sanitizeReturnTo("/albums/summer?edit=1"), "/albums/summer?edit=1");
	assert.equal(domain.sanitizeReturnTo("//evil.example/path"), "/albums");
	assert.equal(domain.sanitizeReturnTo("https://evil.example/path"), "/albums");
});

test("preview URLs use a verified storage key and never guess from a media id", () => {
	assert.equal(
		domain.mediaPreviewUrl({ id: "media-id", src: "/_emdash/api/media/file/folder%2Fphoto.jpg" }),
		"/_yohaku/media/preview-v2/320/webp/folder%2Fphoto.jpg",
	);
	assert.equal(domain.mediaPreviewUrl({ id: "media-id", src: "https://images.example/photo.jpg" }), "https://images.example/photo.jpg");
});
