#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RELATED_ALBUM_FIELD = Object.freeze({
	slug: "related_album",
	label: "関連アルバム",
	type: "reference",
	options: { collection: "albums" },
	widget: "yohaku-photo-tools:related-album-hidden",
	indexed: true,
	translatable: true,
});

function fieldsFrom(response) {
	const fields = response?.data?.items ?? response?.items;
	if (!Array.isArray(fields)) throw new Error("EmDash fields response did not contain data.items");
	return fields;
}

export function inspectRelatedAlbumField(fields) {
	const existing = fields.find((field) => field?.slug === RELATED_ALBUM_FIELD.slug);
	if (!existing) return { status: "missing", field: null, problems: [] };
	const problems = [];
	if (existing.type !== "reference") problems.push(`type is ${JSON.stringify(existing.type)}, expected "reference"`);
	if (existing.required === true) problems.push("field is required, expected optional");
	if (existing.options?.collection !== "albums") problems.push("reference target is not albums");
	if (existing.widget !== RELATED_ALBUM_FIELD.widget) problems.push(`widget is ${JSON.stringify(existing.widget)}`);
	if (existing.indexed !== true) problems.push("field is not indexed");
	if (existing.translatable === false) problems.push("field is non-translatable");
	return { status: problems.length ? "incompatible" : "ready", field: existing, problems };
}

export async function ensureRelatedAlbumField(client, { apply = false } = {}) {
	const before = inspectRelatedAlbumField(fieldsFrom(await client.get("/_emdash/api/schema/collections/posts/fields")));
	if (before.status === "incompatible") {
		throw new Error(`Existing posts.related_album field is incompatible: ${before.problems.join("; ")}`);
	}
	if (before.status === "ready") return { action: "unchanged", before, after: before };
	if (!apply) return { action: "would-create", before, after: before };

	await client.post("/_emdash/api/schema/collections/posts/fields", RELATED_ALBUM_FIELD);
	const after = inspectRelatedAlbumField(fieldsFrom(await client.get("/_emdash/api/schema/collections/posts/fields")));
	if (after.status !== "ready") {
		throw new Error(`posts.related_album postflight verification failed: ${after.problems.join("; ") || after.status}`);
	}
	return { action: "created", before, after };
}

function parseArgs(argv) {
	const result = { apply: false, origin: "", expectedOrigin: "", backupManifest: "", receipt: "" };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--apply") result.apply = true;
		else if (value === "--dry-run") result.apply = false;
		else if (value === "--origin") result.origin = String(argv[++index] ?? "");
		else if (value === "--expected-origin") result.expectedOrigin = String(argv[++index] ?? "");
		else if (value === "--backup-manifest") result.backupManifest = String(argv[++index] ?? "");
		else if (value === "--receipt") result.receipt = String(argv[++index] ?? "");
		else throw new Error(`Unknown argument: ${value}`);
	}
	return result;
}

function checkedOrigin(value, label) {
	let parsed;
	try { parsed = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
	if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
		throw new Error(`${label} must contain only an origin`);
	}
	const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
		throw new Error(`${label} must use HTTPS (HTTP is allowed only for localhost)`);
	}
	return parsed.origin;
}

export async function loadBackupManifest(manifestPath, origin) {
	const resolvedManifestPath = path.resolve(manifestPath);
	let manifest;
	try { manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8")); }
	catch (cause) { throw new Error(`Cannot read backup manifest: ${cause instanceof Error ? cause.message : String(cause)}`); }
	const problems = [];
	if (manifest.source !== origin) problems.push("source does not match the target origin");
	if (typeof manifest.generated_at !== "string" || !manifest.generated_at) problems.push("generated_at is missing");
	if (typeof manifest.database !== "string" || !manifest.database) problems.push("database is missing");
	if (!/^[a-f0-9]{64}$/i.test(manifest.d1?.sha256 ?? "")) problems.push("d1.sha256 is missing or invalid");
	if (typeof manifest.d1?.relative_path !== "string" || !manifest.d1.relative_path) problems.push("d1.relative_path is missing");
	if (!Number.isInteger(manifest.d1?.bytes) || manifest.d1.bytes < 1) problems.push("d1.bytes is missing or invalid");
	if (problems.length) throw new Error(`Backup manifest is not usable: ${problems.join("; ")}`);
	const backupRoot = path.dirname(resolvedManifestPath);
	const d1Path = path.resolve(backupRoot, manifest.d1.relative_path);
	if (d1Path !== backupRoot && !d1Path.startsWith(`${backupRoot}${path.sep}`)) {
		throw new Error("Backup manifest d1.relative_path escapes the backup directory");
	}
	let d1Bytes;
	try { d1Bytes = await readFile(d1Path); }
	catch (cause) { throw new Error(`Cannot read D1 backup: ${cause instanceof Error ? cause.message : String(cause)}`); }
	if (d1Bytes.byteLength !== manifest.d1.bytes) throw new Error("D1 backup byte length does not match the manifest");
	if (createHash("sha256").update(d1Bytes).digest("hex") !== manifest.d1.sha256.toLowerCase()) {
		throw new Error("D1 backup SHA-256 does not match the manifest");
	}
	return {
		manifestPath: resolvedManifestPath,
		generatedAt: manifest.generated_at,
		database: manifest.database,
		d1Path,
		d1Bytes: manifest.d1.bytes,
		d1Sha256: manifest.d1.sha256,
	};
}

class ApiClient {
	constructor(origin, token) {
		this.origin = origin;
		this.token = token;
	}

	async request(pathname, init = {}) {
		const response = await fetch(this.origin + pathname, {
			...init,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
		});
		let payload;
		try { payload = await response.json(); } catch { payload = undefined; }
		if (!response.ok) {
			throw new Error(`${init.method ?? "GET"} ${pathname} ${payload?.error?.code ?? `HTTP_${response.status}`}: ${payload?.error?.message ?? "Request failed"}`);
		}
		return payload;
	}

	get(pathname) { return this.request(pathname); }
	post(pathname, body) { return this.request(pathname, { method: "POST", body: JSON.stringify(body) }); }
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = checkedOrigin(args.origin, "--origin");
	const expectedOrigin = checkedOrigin(args.expectedOrigin, "--expected-origin");
	if (origin !== expectedOrigin) throw new Error(`Origin guard failed: target ${origin} does not match ${expectedOrigin}`);
	const token = process.env.EMDASH_TOKEN;
	if (!token?.startsWith("ec_pat_")) throw new Error("EMDASH_TOKEN must be an EmDash personal access token");
	if (args.apply && (!args.backupManifest || !args.receipt)) {
		throw new Error("--apply requires --backup-manifest and --receipt");
	}
	const backup = args.apply ? await loadBackupManifest(args.backupManifest, origin) : null;
	const startedAt = new Date().toISOString();
	const result = await ensureRelatedAlbumField(new ApiClient(origin, token), { apply: args.apply });
	const receipt = {
		receiptVersion: 1,
		operation: "ensure-posts-related-album-field",
		origin,
		apply: args.apply,
		startedAt,
		completedAt: new Date().toISOString(),
		backup,
		request: RELATED_ALBUM_FIELD,
		action: result.action,
		before: result.before,
		after: result.after,
		contentRowsModified: 0,
		rollback: "Additive optional field: leave the field in place and stop using it; restore the recorded D1 backup only if wider schema damage is observed.",
	};
	if (args.receipt) await writeFile(path.resolve(args.receipt), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
	console.log(JSON.stringify(receipt, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((cause) => {
		console.error(cause instanceof Error ? cause.message : cause);
		process.exitCode = 1;
	});
}
