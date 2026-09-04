import assert from "node:assert/strict";
import test from "node:test";

const session = await import("../src/studio/session.ts");

class MemoryKv {
	values = new Map();
	async get(key) { return this.values.get(key) ?? null; }
	async put(key, value) { this.values.set(key, value); }
	async delete(key) { this.values.delete(key); }
}

test("handoff token is short-lived storage state and sequentially single use", async () => {
	const kv = new MemoryKv();
	const env = { SESSION: kv };
	const token = await session.issueStudioHandoff(env, { id: "admin", role: 50 }, "/albums/trip");
	assert.match(token, /^[a-f0-9]{64}$/);
	assert.equal([...kv.values.values()].some((value) => value.includes(token)), false, "raw token must not be stored");
	const first = await session.redeemStudioHandoff(env, token);
	assert.ok(first);
	assert.equal(first.returnTo, "/albums/trip");
	assert.equal(await session.redeemStudioHandoff(env, token), null);
	assert.deepEqual(await session.readStudioSession(env, first.sessionId), {
		userId: "admin",
		role: 50,
		expiresAt: (await session.readStudioSession(env, first.sessionId)).expiresAt,
	});
});

test("non-admin sessions are rejected and removed", async () => {
	const kv = new MemoryKv();
	const env = { SESSION: kv };
	const token = await session.issueStudioHandoff(env, { id: "editor", role: 40 }, "/albums");
	const redeemed = await session.redeemStudioHandoff(env, token);
	assert.ok(redeemed);
	assert.equal(await session.readStudioSession(env, redeemed.sessionId), null);
});
