import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { photoPath } from "../src/utils/photo-url.mjs";

describe("photoPath", () => {
	test("uses the concise canonical photo route", () => {
		assert.equal(photoPath("kph_stable"), "/p/kph_stable");
	});

	test("encodes a slug before placing it in a URL", () => {
		assert.equal(photoPath("photo sample"), "/p/photo%20sample");
	});
});
