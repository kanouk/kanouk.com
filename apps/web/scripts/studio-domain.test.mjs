import assert from "node:assert/strict";
import test from "node:test";

const domain = await import("../src/studio/domain.ts");

test("review flags expose missing fields, stored location metadata and draft state", () => {
	const flags = domain.photoReviewFlags({
		caption: "",
		alt: "",
		image: { id: "missing" },
		source_metadata: { exif: { GPSLatitude: 35.6 } },
	}, { status: "draft" });
	assert.deepEqual(flags, ["missing-caption", "missing-alt", "has-location", "unpublished"]);
});

test("organizer uploads remain blocked until location review is marked clean", () => {
	assert.equal(domain.needsLocationReview({
		source_metadata: { photo_organizer_upload: true, location_review: "unreviewed" },
	}), true);
	assert.equal(domain.needsLocationReview({
		source_metadata: { photo_organizer_upload: true, location_review: "clean" },
	}), false);
	assert.ok(domain.photoReviewFlags({
		caption: "caption",
		alt: "alt",
		source_metadata: { photo_organizer_upload: true, location_review: "unreviewed" },
	}).includes("location-unreviewed"));
});

test("bulk text modes preserve unspecified fields", () => {
	const original = { title: "Photo", caption: "existing", alt: "old", album: "album-a" };
	assert.deepEqual(domain.applyBulkPatch(original, {
		caption: { value: "prefix: ", mode: "prepend" },
		alt: { value: " appended", mode: "append" },
	}), { title: "Photo", caption: "prefix: existing", alt: "old appended", album: "album-a" });
});

test("album positions are sparse and deterministic", () => {
	assert.deepEqual(domain.sparsePositions(4), [1024, 2048, 3072, 4096]);
});

test("captured date sort is chronological, offset-aware and puts missing dates last", () => {
	assert.ok(domain.compareCapturedAt("2026-09-01T08:00:00+09:00", "2026-09-01T00:30:00Z") < 0);
	assert.ok(domain.compareCapturedAt("", "2026-09-01T00:00:00Z") > 0);
	assert.ok(domain.compareCapturedAt("", "", 1024, 2048, "b", "a") < 0);
});

test("preview URLs use a verified storage key and never guess from a media id", () => {
	assert.equal(
		domain.mediaPreviewUrl({ id: "media-id", src: "/_emdash/api/media/file/folder%2Fphoto.jpg" }),
		"/_yohaku/media/preview-v2/320/webp/folder%2Fphoto.jpg",
	);
	assert.equal(domain.mediaPreviewUrl({ id: "media-id", src: "https://images.example/photo.jpg" }), "https://images.example/photo.jpg");
});
