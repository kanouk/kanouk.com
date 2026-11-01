import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { billingMonth, MONTHLY_GOOGLE_MAP_LOADS, reserveGoogleMapLoad } from "../src/utils/map-quota.mjs";

function d1() {
	const database = new DatabaseSync(":memory:");
	return {
		prepare(sql) {
			const statement = (values = []) => ({
				first: async () => database.prepare(sql).get(...values) ?? null,
				run: async () => database.exec(sql),
			});
			return { ...statement(), bind: (...values) => statement(values) };
		},
	};
}

test("the monthly limit stops before Google's 10,000 free loads", () => {
	assert.equal(MONTHLY_GOOGLE_MAP_LOADS, 9500);
});

test("loads are counted up to the limit, and a new month starts over", async () => {
	const database = d1();
	const october = new Date("2026-10-15T00:00:00Z");
	assert.equal(await reserveGoogleMapLoad(database, october, 2), true);
	assert.equal(await reserveGoogleMapLoad(database, october, 2), true);
	assert.equal(await reserveGoogleMapLoad(database, october, 2), false);
	assert.equal(await reserveGoogleMapLoad(database, october, 2), false);
	assert.equal(await reserveGoogleMapLoad(database, new Date("2026-11-15T00:00:00Z"), 2), true);
});

test("the month turns over on Pacific time, as Google's free usage does", () => {
	assert.equal(billingMonth(new Date("2026-11-01T06:59:00Z")), "2026-10");
	assert.equal(billingMonth(new Date("2026-11-01T07:00:00Z")), "2026-11");
});
