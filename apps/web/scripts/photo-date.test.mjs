import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { capturedDateParts, capturedRangeLabel } from "../src/utils/photo-date.mjs";

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

	test("labels a capture range compactly", () => {
		assert.equal(capturedRangeLabel("2024-06-06T21:27:33.000Z", "2024-06-11T02:42:17.000Z"), "2024年6月7日〜11日");
		assert.equal(capturedRangeLabel("2024-06-30T01:00:00.000Z", "2024-07-02T01:00:00.000Z"), "2024年6月30日〜7月2日");
		assert.equal(capturedRangeLabel("2024-12-30T01:00:00.000Z", "2025-01-02T01:00:00.000Z"), "2024年12月30日〜2025年1月2日");
		assert.equal(capturedRangeLabel("2024-06-07T01:00:00.000Z", "2024-06-07T09:00:00.000Z"), "2024年6月7日");
		assert.equal(capturedRangeLabel(null, "2024-06-07T09:00:00.000Z"), undefined);
	});
});
