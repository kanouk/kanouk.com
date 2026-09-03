import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sortPhotosChronologically } from "../src/utils/photo-order.mjs";

const photo = (id, capturedAt, position = 0) => ({
	id,
	data: {
		captured_at: capturedAt,
		position,
	},
});

describe("sortPhotosChronologically", () => {
	test("places the oldest captured photo first", () => {
		const photos = [
			photo("newest", "2024-06-01T12:00:00Z", 1),
			photo("oldest", "2024-06-01T09:00:00Z", 2),
			photo("middle", "2024-06-01T10:30:00Z", 3),
		];

		assert.deepEqual(
			sortPhotosChronologically(photos).map(({ id }) => id),
			["oldest", "middle", "newest"],
		);
	});

	test("compares offset timestamps by their actual instant", () => {
		const photos = [
			photo("later", "2024-06-01T10:00:00+09:00"),
			photo("earlier", "2024-06-01T00:30:00Z"),
		];

		assert.deepEqual(
			sortPhotosChronologically(photos).map(({ id }) => id),
			["earlier", "later"],
		);
	});

	test("places missing dates last and uses position then id as stable fallbacks", () => {
		const photos = [
			photo("missing-b", undefined, 2),
			photo("same-b", "2024-06-01T09:00:00Z", 2),
			photo("missing-a", "", 1),
			photo("same-a", "2024-06-01T09:00:00Z", 1),
		];

		assert.deepEqual(
			sortPhotosChronologically(photos).map(({ id }) => id),
			["same-a", "same-b", "missing-a", "missing-b"],
		);
	});

	test("does not mutate the fetched collection", () => {
		const photos = [
			photo("later", "2024-06-02T00:00:00Z"),
			photo("earlier", "2024-06-01T00:00:00Z"),
		];

		sortPhotosChronologically(photos);
		assert.deepEqual(photos.map(({ id }) => id), ["later", "earlier"]);
	});
});
