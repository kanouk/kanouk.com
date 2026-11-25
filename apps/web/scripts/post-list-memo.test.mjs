import assert from "node:assert/strict";
import test from "node:test";
import { clearEdgeMemo } from "../src/utils/edge-memo.mjs";
import { sharedPostList, termListKey } from "../src/utils/post-list-memo.mjs";

test("articles with the same terms share one post-list read", async () => {
	clearEdgeMemo();
	let loads = 0;
	const load = async () => {
		loads += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { entries: [{ id: "a" }], cacheHint: { tags: ["posts"] } };
	};
	const key = termListKey("tag", ["kyoto", "cafe"], 4);
	assert.equal(key, termListKey("tag", ["cafe", "kyoto"], 4));
	assert.notEqual(key, termListKey("category", ["cafe", "kyoto"], 4));
	assert.notEqual(key, termListKey("tag", ["cafe", "kyoto"], 5));
	const [first, second] = await Promise.all([sharedPostList(key, load), sharedPostList(key, load)]);
	assert.equal(loads, 1, "concurrent renders share the in-flight read");
	assert.equal(first, second);
	assert.equal(await sharedPostList(key, load), first);
	assert.equal(loads, 1, "later renders reuse the kept answer");
});

test("a failed post-list read is not kept", async () => {
	clearEdgeMemo();
	let loads = 0;
	const failing = async () => {
		loads += 1;
		return { entries: [], error: new Error("D1 overloaded") };
	};
	await sharedPostList("recent:4", failing);
	await sharedPostList("recent:4", failing);
	assert.equal(loads, 2);
	await assert.rejects(sharedPostList("recent:thrown", async () => { throw new Error("boom"); }));
	assert.deepEqual(await sharedPostList("recent:thrown", async () => ({ entries: [] })), { entries: [] });
});
