#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
	buildProductMap,
	convertPostContent,
	repairEmptyPochippProductCards,
} from "./yohaku-transformers.mjs";
import { buildImportPlan, loadQuizMap } from "./import-wxr.mjs";

export const EXPECTED_ORIGIN = "https://kanouk-emdash-staging.kanouk.workers.dev";
export const DEFAULT_PRIVATE_BACKUP_ROOT = "/Users/kanouk/Documents/Private_External_Imports";

export function parseArgs(argv) {
	const result = { apply: false, backupDir: undefined, contentIds: [] };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--apply") result.apply = true;
		else if (value === "--dry-run") result.apply = false;
		else if (value === "--content-id") result.contentIds.push(String(argv[++index] || ""));
		else if (value === "--backup-dir") result.backupDir = String(argv[++index] || "");
		else throw new Error(`Unknown argument: ${value}`);
	}
	result.contentIds = [...new Set(result.contentIds)];
	if (!result.contentIds.length || result.contentIds.some((id) => !/^01[A-Z0-9]{24}$/.test(id))) {
		throw new Error("Provide at least one valid --content-id; bulk selection is intentionally unsupported");
	}
	if (result.apply && !result.backupDir) {
		throw new Error("--apply requires an explicit --backup-dir inside the private import backup root");
	}
	return result;
}

export function assertPrivateBackupPath(candidate, privateRoot = DEFAULT_PRIVATE_BACKUP_ROOT) {
	if (!candidate || !path.isAbsolute(candidate)) throw new Error("--backup-dir must be an absolute path");
	const root = path.resolve(privateRoot);
	const resolved = path.resolve(candidate);
	if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error("--backup-dir must be a child of the private import backup root");
	}
	return resolved;
}

function stableValue(value) {
	return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

async function request(origin, token, pathname, options = {}) {
	const response = await fetch(origin + pathname, {
		...options,
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			...(options.body ? { "Content-Type": "application/json" } : {}),
		},
	});
	let payload;
	try { payload = await response.json(); } catch { payload = undefined; }
	if (!response.ok) {
		throw new Error(`${options.method || "GET"} ${pathname}: ${payload?.error?.message || response.status}`);
	}
	return payload?.data;
}

export async function writeProductCardBackup({
	backupDir,
	privateRoot = DEFAULT_PRIVATE_BACKUP_ROOT,
	origin,
	id,
	current,
	now = new Date(),
}) {
	const resolvedDir = assertPrivateBackupPath(backupDir, privateRoot);
	await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
	const [rootReal, dirReal] = await Promise.all([fs.realpath(privateRoot), fs.realpath(resolvedDir)]);
	if (!dirReal.startsWith(`${rootReal}${path.sep}`)) throw new Error("Backup directory escapes the private import backup root");
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	const filename = path.join(dirReal, `${id}.${timestamp}.before.json`);
	const contentJson = stableJson(current.item?.data?.content || []);
	const payload = {
		version: 1,
		capturedAt: now.toISOString(),
		origin,
		collection: "posts",
		contentId: id,
		revision: current._rev,
		contentSha256: createHash("sha256").update(contentJson).digest("hex"),
		item: current.item,
	};
	const serialized = `${JSON.stringify(payload, null, 2)}\n`;
	await fs.writeFile(filename, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
	if (await fs.readFile(filename, "utf8") !== serialized) throw new Error(`Backup readback failed: ${filename}`);
	return filename;
}

function sourceContent(record, quizzes) {
	const reusableBlocks = new Map(
		record.wxr.posts
			.filter((candidate) => candidate.postType === "wp_block")
			.map((candidate) => [String(candidate.id), candidate]),
	);
	return convertPostContent(record.post, {
		siteId: record.source.id,
		dialogueProfiles: record.source.dialogueProfiles || {},
		products: buildProductMap(record.wxr.posts),
		reusableBlocks,
		quizzes,
	});
}

export async function runProductCardBackfill({
	args,
	origin,
	token,
	privateRoot = DEFAULT_PRIVATE_BACKUP_ROOT,
	requestFn = request,
	planLoader = buildImportPlan,
	quizLoader = loadQuizMap,
	log = console.log,
}) {
	if (origin !== EXPECTED_ORIGIN || !token?.startsWith("ec_pat_")) {
		throw new Error("Pinned EmDash origin and scoped token are required through the guard wrapper");
	}
	const [{ records }, quizzes] = await Promise.all([planLoader(), quizLoader()]);
	const recordsBySourceId = new Map(
		records
			.filter((record) => record.post.postType === "post")
			.map((record) => [`${record.source.id}:${record.post.id}`, record]),
	);
	let updated = 0;
	let repairedCards = 0;
	for (const id of args.contentIds) {
		const pathname = `/_emdash/api/content/posts/${encodeURIComponent(id)}`;
		const current = await requestFn(origin, token, pathname);
		if (!current?._rev) throw new Error(`${id} response has no revision; product-card repair is refused`);
		if (current.item?.status === "published" && current.item?.draftRevisionId) {
			throw new Error(`${id} has a pending draft; product-card repair is refused`);
		}
		const sourceId = String(current.item?.data?.source_id || "");
		const record = recordsBySourceId.get(sourceId);
		if (!record) throw new Error(`${id} has no matching WordPress post source record: ${sourceId}`);
		const repaired = repairEmptyPochippProductCards(
			current.item?.data?.content || [],
			sourceContent(record, quizzes),
		);
		if (!repaired.ok) throw new Error(`${id} repair refused: ${repaired.reason}`);
		if (!repaired.repaired) {
			log(`${id} unchanged`);
			continue;
		}
		repairedCards += repaired.repaired;
		if (!args.apply) {
			log(`${id} would_update product_cards=${repaired.repaired}`);
			continue;
		}
		await writeProductCardBackup({
			backupDir: args.backupDir,
			privateRoot,
			origin,
			id,
			current,
		});
		const putResult = await requestFn(origin, token, pathname, {
			method: "PUT",
			body: JSON.stringify({ data: { content: repaired.value }, _rev: current._rev }),
		});
		// Publishing has no CAS parameter. Read the draft back first and only
		// publish when it is still exactly the revision/content just written.
		const saved = await requestFn(origin, token, pathname);
		if (!putResult?._rev || saved?._rev !== putResult._rev) {
			throw new Error(`${id} revision changed after PUT; refusing to publish`);
		}
		if (stableJson(saved.item?.data?.content || []) !== stableJson(repaired.value)) {
			throw new Error(`${id} draft readback differs; refusing to publish`);
		}
		if (current.item.status === "published") {
			await requestFn(origin, token, `${pathname}/publish`, {
				method: "POST",
				body: JSON.stringify({}),
			});
		}
		const verified = await requestFn(origin, token, pathname);
		if (stableJson(verified.item?.data?.content || []) !== stableJson(repaired.value)) {
			throw new Error(`${id} final readback differs`);
		}
		if (current.item.status === "published" && (verified.item?.status !== "published" || verified.item?.draftRevisionId)) {
			throw new Error(`${id} was not published cleanly`);
		}
		updated++;
		log(`${id} updated_verified product_cards=${repaired.repaired}`);
	}
	const summary = { apply: args.apply, selected: args.contentIds.length, updated, repairedCards };
	log(JSON.stringify(summary));
	return summary;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	await runProductCardBackfill({
		args,
		origin: process.env.EMDASH_URL,
		token: process.env.EMDASH_TOKEN,
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
