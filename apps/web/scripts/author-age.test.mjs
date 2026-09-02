import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calculateAge } from "../src/utils/author-age.mjs";

describe("calculateAge", () => {
	test("changes age at midnight in Japan on the birthday", () => {
		assert.equal(calculateAge("1977-06-18", new Date("2026-06-17T14:59:59Z")), 48);
		assert.equal(calculateAge("1977-06-18", new Date("2026-06-17T15:00:00Z")), 49);
	});

	test("returns the current age after the birthday", () => {
		assert.equal(calculateAge("1977-06-18", new Date("2026-09-02T03:00:00Z")), 49);
	});
});
