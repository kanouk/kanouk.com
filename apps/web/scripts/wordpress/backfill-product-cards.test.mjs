import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	EXPECTED_ORIGIN,
	assertPrivateBackupPath,
	parseArgs,
	runProductCardBackfill,
	writeProductCardBackup,
} from "./backfill-product-cards.mjs";

const CONTENT_ID = "01M1CRQ58C3TMGVKAJP7YXPP0H";

test("requires explicit valid post IDs and defaults to dry run", () => {
	assert.throws(() => parseArgs([]), /at least one valid --content-id/);
	assert.throws(() => parseArgs(["--content-id", "not-an-id"]), /valid --content-id/);
	assert.throws(() => parseArgs(["--all"]), /Unknown argument/);
	assert.deepEqual(parseArgs(["--content-id", CONTENT_ID]), {
		apply: false,
		backupDir: undefined,
		contentIds: [CONTENT_ID],
	});
	assert.throws(() => parseArgs(["--content-id", CONTENT_ID, "--apply"]), /requires an explicit --backup-dir/);
});

test("backup target must be an absolute child of its private root", () => {
	assert.equal(assertPrivateBackupPath("/private/root/run", "/private/root"), "/private/root/run");
	assert.throws(() => assertPrivateBackupPath("run", "/private/root"), /absolute path/);
	assert.throws(() => assertPrivateBackupPath("/private/root", "/private/root"), /must be a child/);
	assert.throws(() => assertPrivateBackupPath("/private/root-other/run", "/private/root"), /must be a child/);
});

test("writes and verifies a private before-image without credentials", async (t) => {
	const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "product-card-backup-"));
	t.after(() => fs.rm(privateRoot, { recursive: true, force: true }));
	const current = { _rev: "rev-1", item: { id: CONTENT_ID, data: { content: [{ _type: "block" }] } } };
	const filename = await writeProductCardBackup({
		backupDir: path.join(privateRoot, "run-1"),
		privateRoot,
		origin: EXPECTED_ORIGIN,
		id: CONTENT_ID,
		current,
		now: new Date("2026-09-07T00:00:00.000Z"),
	});
	const payload = JSON.parse(await fs.readFile(filename, "utf8"));
	assert.equal(payload.revision, "rev-1");
	assert.equal(payload.contentId, CONTENT_ID);
	assert.equal(payload.origin, EXPECTED_ORIGIN);
	assert.equal("token" in payload, false);
});

function fixtureRecord() {
	return {
		source: { id: "kanolog", dialogueProfiles: {} },
		wxr: { posts: [] },
		post: {
			id: 8732,
			postType: "post",
			content: '<!-- wp:pochipp/linkbox {"title":"阿・吽 全巻セット","keywords":"阿吽","image_url":"https://example.test/aun.jpg","price":"10221"} /-->',
		},
	};
}

function currentResponse(overrides = {}) {
	return {
		_rev: "rev-before",
		item: {
			id: CONTENT_ID,
			status: "draft",
			draftRevisionId: null,
			data: {
				source_id: "kanolog:8732",
				content: [{
					_type: "yohaku.productCard",
					_key: "existing-key",
					title: "商品情報",
					label: "商品を見る",
					links: [],
					sourceProductId: "",
				}],
			},
			...overrides,
		},
	};
}

test("dry run performs no writes", async () => {
	const methods = [];
	const summary = await runProductCardBackfill({
		args: parseArgs(["--content-id", CONTENT_ID]),
		origin: EXPECTED_ORIGIN,
		token: "ec_pat_test",
		planLoader: async () => ({ records: [fixtureRecord()] }),
		quizLoader: async () => new Map(),
		requestFn: async (_origin, _token, _path, options = {}) => {
			methods.push(options.method || "GET");
			return currentResponse();
		},
		log: () => {},
	});
	assert.deepEqual(methods, ["GET"]);
	assert.equal(summary.repairedCards, 1);
	assert.equal(summary.updated, 0);
});

test("refuses a pending published draft before any write", async () => {
	await assert.rejects(() => runProductCardBackfill({
		args: parseArgs(["--content-id", CONTENT_ID]),
		origin: EXPECTED_ORIGIN,
		token: "ec_pat_test",
		planLoader: async () => ({ records: [fixtureRecord()] }),
		quizLoader: async () => new Map(),
		requestFn: async () => currentResponse({ status: "published", draftRevisionId: "draft-1" }),
		log: () => {},
	}), /pending draft/);
});

test("apply backs up, sends content-only CAS data, verifies revision, then publishes with an empty body", async (t) => {
	const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "product-card-apply-"));
	t.after(() => fs.rm(privateRoot, { recursive: true, force: true }));
	const backupDir = path.join(privateRoot, "run-1");
	const calls = [];
	const initial = currentResponse({ status: "published", publishedAt: "2026-08-01T00:00:00.000Z" });
	let repairedContent;
	const requestFn = async (_origin, _token, requestPath, options = {}) => {
		const method = options.method || "GET";
		calls.push({ method, requestPath, body: options.body });
		if (method === "PUT") {
			const body = JSON.parse(options.body);
			assert.deepEqual(Object.keys(body).sort(), ["_rev", "data"]);
			assert.deepEqual(Object.keys(body.data), ["content"]);
			assert.equal(body._rev, "rev-before");
			repairedContent = body.data.content;
			assert.ok((await fs.readdir(backupDir)).some((name) => name.endsWith(".before.json")));
			return { _rev: "rev-after", item: { ...initial.item, data: { ...initial.item.data, content: repairedContent } } };
		}
		if (method === "POST") {
			assert.equal(requestPath.endsWith("/publish"), true);
			assert.deepEqual(JSON.parse(options.body), {});
			return {};
		}
		const gets = calls.filter((call) => call.method === "GET").length;
		if (gets === 1) return initial;
		return {
			_rev: "rev-after",
			item: {
				...initial.item,
				status: "published",
				draftRevisionId: gets === 2 ? "draft-after" : null,
				data: { ...initial.item.data, content: repairedContent },
			},
		};
	};
	const summary = await runProductCardBackfill({
		args: parseArgs(["--content-id", CONTENT_ID, "--apply", "--backup-dir", backupDir]),
		origin: EXPECTED_ORIGIN,
		token: "ec_pat_test",
		privateRoot,
		planLoader: async () => ({ records: [fixtureRecord()] }),
		quizLoader: async () => new Map(),
		requestFn,
		log: () => {},
	});
	assert.equal(summary.updated, 1);
	assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT", "GET", "POST", "GET"]);
});
