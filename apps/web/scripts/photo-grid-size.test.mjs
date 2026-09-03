import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PHOTO_GRID_SIZE,
	normalizePhotoGridSize,
} from "../src/utils/photo-grid-size.mjs";

describe("normalizePhotoGridSize", () => {
	it("uses the default for invalid stored values", () => {
		assert.equal(normalizePhotoGridSize("not-a-number"), PHOTO_GRID_SIZE.defaultValue);
	});

	it("clamps values to the supported thumbnail range", () => {
		assert.equal(normalizePhotoGridSize(20), PHOTO_GRID_SIZE.min);
		assert.equal(normalizePhotoGridSize(900), PHOTO_GRID_SIZE.max);
	});

	it("snaps values to stable slider steps", () => {
		assert.equal(normalizePhotoGridSize(175), 176);
		assert.equal(normalizePhotoGridSize(184), 192);
	});
});
