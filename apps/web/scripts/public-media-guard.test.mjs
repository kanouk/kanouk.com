import assert from "node:assert/strict";
import test from "node:test";

const { guardPublicOriginalRead } = await import("../src/studio/public-media-guard.ts");

function databaseReturning(result, expectedStorageKey) {
	return {
		prepare(query) {
			assert.match(query, /JOIN revisions AS live ON live\.id = photo\.live_revision_id/);
			assert.match(query, /photo\.deleted_at IS NULL/);
			assert.match(query, /location_review/);
			return {
				bind(storageKey) {
					if (expectedStorageKey) assert.equal(storageKey, expectedStorageKey);
					return { first: async () => result };
				},
			};
		},
	};
}

test("photo host serves only originals referenced by an allowed, non-deleted live revision", async () => {
	const allowed = await guardPublicOriginalRead(
		new Request("https://photos.kanouk.com/_emdash/api/media/file/folder%2Fphoto.jpg"),
		databaseReturning({ allowed: 1 }, "folder/photo.jpg"),
	);
	assert.equal(allowed, null);

	const blocked = await guardPublicOriginalRead(
		new Request("https://photos.kanouk.com/_emdash/api/media/file/unreviewed.jpg"),
		databaseReturning(null),
	);
	assert.equal(blocked?.status, 404);
	assert.equal(blocked?.headers.get("Cache-Control"), "private, no-store");
});

test("a deleted or otherwise ineligible Photo returns 404", async () => {
	const blocked = await guardPublicOriginalRead(
		new Request("https://photos.kanouk.com/_emdash/api/media/file/deleted-photo.jpg"),
		databaseReturning(null),
	);
	assert.equal(blocked?.status, 404);
});

test("non-photo hosts and writes are left to the normal authenticated routing", async () => {
	const unexpectedDatabase = {
		prepare() {
			throw new Error("database must not be queried");
		},
	};
	assert.equal(await guardPublicOriginalRead(
		new Request("https://blog.kanouk.com/_emdash/api/media/file/photo.jpg"),
		unexpectedDatabase,
	), null);
	assert.equal(await guardPublicOriginalRead(
		new Request("https://photos.kanouk.com/_emdash/api/media/file/photo.jpg", { method: "POST" }),
		unexpectedDatabase,
	), null);
});
