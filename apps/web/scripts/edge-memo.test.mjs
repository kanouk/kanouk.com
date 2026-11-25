import { test } from "node:test";
import assert from "node:assert/strict";
import { clearEdgeMemo, digestKey, edgeMemo } from "../src/utils/edge-memo.mjs";

test("a cached aggregate is read from D1 once within its TTL", async () => {
	const scope = {};
	let loads = 0;
	const load = async () => ({ loads: ++loads });
	assert.deepEqual(await edgeMemo("k", 60, load, { scope }), { loads: 1 });
	assert.deepEqual(await edgeMemo("k", 60, load, { scope }), { loads: 1 });
	assert.equal(loads, 1);
	clearEdgeMemo(scope);
	assert.deepEqual(await edgeMemo("k", 60, load, { scope }), { loads: 2 });
});

test("read errors and uncacheable values are never remembered", async () => {
	const scope = {};
	await assert.rejects(edgeMemo("k", 60, async () => { throw new Error("D1 DB is overloaded"); }, { scope }));
	assert.deepEqual(await edgeMemo("k", 60, async () => [], { scope, cacheable: (v) => v.length > 0 }), []);
	assert.deepEqual(await edgeMemo("k", 60, async () => ["fresh"], { scope, cacheable: (v) => v.length > 0 }), ["fresh"]);
});

test("entries are isolated per database binding", async () => {
	const first = {};
	const second = {};
	assert.equal(await edgeMemo("k", 60, async () => "first", { scope: first }), "first");
	assert.equal(await edgeMemo("k", 60, async () => "second", { scope: second }), "second");
});

test("an expired entry is reloaded and a zero TTL is not stored", async () => {
	const scope = {};
	let loads = 0;
	await edgeMemo("k", () => 0, async () => ++loads, { scope });
	await edgeMemo("k", () => 0, async () => ++loads, { scope });
	assert.equal(loads, 2);
});

test("digest keys are short and stable", async () => {
	assert.equal(await digestKey("abc"), await digestKey("abc"));
	assert.notEqual(await digestKey("abc"), await digestKey("abd"));
	assert.equal((await digestKey("x".repeat(5000))).length, 32);
});
