import assert from "node:assert/strict";
import test from "node:test";
import { albumCoverSizes, coverCrop, coverCropStyle } from "../src/utils/cover-crop.mjs";

test("reads a saved crop and keeps it in range", () => {
	assert.deepEqual(coverCrop({ meta: { crop: { x: 0.25, y: 1.5, zoom: 9 } } }), { x: 0.25, y: 1, zoom: 3 });
});

test("ignores covers without a usable crop", () => {
	assert.equal(coverCrop(null), null);
	assert.equal(coverCrop({ meta: { storageKey: "a.jpg" } }), null);
	assert.equal(coverCrop({ meta: { crop: { x: "0.5", y: 0.5, zoom: 1 } } }), null);
});

test("positions and scales around the same point", () => {
	assert.equal(
		coverCropStyle({ x: 0.25, y: 0.5, zoom: 2 }),
		"object-position:25.00% 50.00%;transform-origin:25.00% 50.00%;--cover-zoom:2.000",
	);
});

test("asks for a larger image when zoomed", () => {
	assert.equal(albumCoverSizes(null), "(max-width: 719px) calc(50vw - 1.3rem), (max-width: 1100px) 33vw, 18rem");
	assert.match(albumCoverSizes({ x: 0.5, y: 0.5, zoom: 2 }), /calc\(18rem \* 2\.000\)$/);
});
