import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { capturedDateParts } from "../src/utils/photo-date.mjs";

describe("capturedDateParts", () => {
	test("keeps the Japanese date of a UTC-normalized early-morning capture", () => {
		assert.deepEqual(capturedDateParts("2024-06-06T21:27:33.000Z"), { year: 2024, month: 6, day: 7 });
		assert.deepEqual(capturedDateParts("2024-06-07T06:27:33+09:00"), { year: 2024, month: 6, day: 7 });
	});

	test("reads zone-less values as written", () => {
		assert.deepEqual(capturedDateParts("2013-07-20T23:10:00"), { year: 2013, month: 7, day: 20 });
		assert.deepEqual(capturedDateParts("2005-03-26"), { year: 2005, month: 3, day: 26 });
	});

	test("returns undefined for missing or invalid values", () => {
		assert.equal(capturedDateParts(undefined), undefined);
		assert.equal(capturedDateParts(""), undefined);
		assert.equal(capturedDateParts("unknown"), undefined);
	});
});
