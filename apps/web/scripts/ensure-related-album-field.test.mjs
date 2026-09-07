import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	RELATED_ALBUM_FIELD,
	ensureRelatedAlbumField,
	inspectRelatedAlbumField,
	loadBackupManifest,
} from "./ensure-related-album-field.mjs";

function fakeClient(initialFields) {
	const fields = structuredClone(initialFields);
	const calls = [];
	return {
		calls,
		async get(pathname) {
			calls.push(["GET", pathname]);
			return { data: { items: structuredClone(fields) } };
		},
		async post(pathname, body) {
			calls.push(["POST", pathname, structuredClone(body)]);
			fields.push({ id: "field-related-album", required: false, ...structuredClone(body) });
			return { data: { item: fields.at(-1) } };
		},
	};
}

test("missing related_album is reported without mutation in dry-run mode", async () => {
	const client = fakeClient([{ slug: "title", type: "string" }]);
	const result = await ensureRelatedAlbumField(client);
	assert.equal(result.action, "would-create");
	assert.equal(result.before.status, "missing");
	assert.deepEqual(client.calls, [["GET", "/_emdash/api/schema/collections/posts/fields"]]);
});

test("the exact optional album reference is idempotent", async () => {
	const field = { id: "field-related-album", required: false, ...RELATED_ALBUM_FIELD };
	assert.equal(inspectRelatedAlbumField([field]).status, "ready");
	const client = fakeClient([field]);
	const result = await ensureRelatedAlbumField(client, { apply: true });
	assert.equal(result.action, "unchanged");
	assert.equal(client.calls.filter(([method]) => method === "POST").length, 0);
});

test("apply creates only the missing field and verifies its persisted contract", async () => {
	const client = fakeClient([{ slug: "title", type: "string" }]);
	const result = await ensureRelatedAlbumField(client, { apply: true });
	assert.equal(result.action, "created");
	assert.equal(result.after.status, "ready");
	assert.deepEqual(client.calls[1], [
		"POST",
		"/_emdash/api/schema/collections/posts/fields",
		RELATED_ALBUM_FIELD,
	]);
	assert.equal(client.calls.at(-1)[0], "GET");
});

test("an existing incompatible field fails closed", async () => {
	for (const incompatible of [
		{ ...RELATED_ALBUM_FIELD, type: "string" },
		{ ...RELATED_ALBUM_FIELD, required: true },
		{ ...RELATED_ALBUM_FIELD, options: { collection: "photos" } },
		{ ...RELATED_ALBUM_FIELD, widget: "another:widget" },
		{ ...RELATED_ALBUM_FIELD, indexed: false },
		{ ...RELATED_ALBUM_FIELD, translatable: false },
	]) {
		const client = fakeClient([incompatible]);
		await assert.rejects(
			ensureRelatedAlbumField(client, { apply: true }),
			/Existing posts\.related_album field is incompatible/,
		);
		assert.equal(client.calls.filter(([method]) => method === "POST").length, 0);
	}
});

test("the apply guard accepts a verified D1-only manifest for the same worker", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "related-album-backup-"));
	try {
		const bytes = Buffer.from("BEGIN; COMMIT;\n");
		await writeFile(path.join(directory, "d1.sql"), bytes);
		await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
			backup_version: 3,
			scope: "d1-only",
			generated_at: "2026-09-07T00:00:00+00:00",
			source: "https://kanouk-emdash-staging.kanouk.workers.dev",
			database: "kanouk-content-staging",
			d1: {
				relative_path: "d1.sql",
				bytes: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		}));
		const backup = await loadBackupManifest(
			path.join(directory, "manifest.json"),
			"https://kanouk-emdash-staging.kanouk.workers.dev",
		);
		assert.equal(backup.database, "kanouk-content-staging");
		assert.equal(backup.d1Bytes, bytes.byteLength);
		await assert.rejects(
			loadBackupManifest(path.join(directory, "manifest.json"), "https://other.example"),
			/source does not match/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
