#!/usr/bin/env node

// Puts the post editor in reading order: title, featured image (compact), excerpt (3 rows), body.
// Changes only field order, the featured image widget, and the excerpt's rows; no content rows.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ApiClient, checkedOrigin, loadBackupManifest } from "./ensure-related-album-field.mjs";

export const POST_EDITOR_LAYOUT = Object.freeze({
	leading: Object.freeze(["title", "featured_image", "excerpt", "content"]),
	featuredWidget: "yohaku-photo-tools:featured-image-compact",
	excerptRows: 3,
});

const FIELDS_PATH = "/_emdash/api/schema/collections/posts/fields";

function fieldsFrom(response) {
	const fields = response?.data?.items ?? response?.items;
	if (!Array.isArray(fields)) throw new Error("EmDash fields response did not contain data.items");
	return fields;
}

const bySortOrder = (fields) => fields.toSorted((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));

/** The full slug order with the leading fields first and everything else in its current order. */
export function desiredOrder(fields) {
	const slugs = bySortOrder(fields).map((field) => field.slug);
	return [...POST_EDITOR_LAYOUT.leading, ...slugs.filter((slug) => !POST_EDITOR_LAYOUT.leading.includes(slug))];
}

export function inspectPostEditorLayout(fields) {
	const find = (slug) => fields.find((field) => field?.slug === slug);
	const missing = POST_EDITOR_LAYOUT.leading.filter((slug) => !find(slug));
	if (missing.length) return { status: "incompatible", problems: [`missing fields: ${missing.join(", ")}`] };
	const problems = [];
	if (find("featured_image").type !== "image") problems.push("featured_image is not an image field");
	if (find("excerpt").type !== "text") problems.push("excerpt is not a text field");
	if (problems.length) return { status: "incompatible", problems };
	const pending = [];
	const current = bySortOrder(fields).map((field) => field.slug);
	if (current.join() !== desiredOrder(fields).join()) pending.push("order");
	if (find("featured_image").widget !== POST_EDITOR_LAYOUT.featuredWidget) pending.push("featured_image.widget");
	if (find("excerpt").options?.rows !== POST_EDITOR_LAYOUT.excerptRows) pending.push("excerpt.options.rows");
	return { status: pending.length ? "pending" : "ready", problems: [], pending, order: current };
}

function updateBody(field, changes) {
	// The update schema requires `validation` (nullable); keep what the field already has.
	return { validation: field.validation ?? null, ...changes };
}

export async function ensurePostEditorLayout(client, { apply = false } = {}) {
	const fields = fieldsFrom(await client.get(FIELDS_PATH));
	const before = inspectPostEditorLayout(fields);
	if (before.status === "incompatible") throw new Error(`posts schema is incompatible: ${before.problems.join("; ")}`);
	if (before.status === "ready") return { action: "unchanged", before, after: before };
	const plan = { order: desiredOrder(fields), pending: before.pending };
	if (!apply) return { action: "would-update", before, after: before, plan };

	const find = (slug) => fields.find((field) => field.slug === slug);
	if (before.pending.includes("featured_image.widget")) {
		await client.put(`${FIELDS_PATH}/featured_image`, updateBody(find("featured_image"), { widget: POST_EDITOR_LAYOUT.featuredWidget }));
	}
	if (before.pending.includes("excerpt.options.rows")) {
		const excerpt = find("excerpt");
		await client.put(`${FIELDS_PATH}/excerpt`, updateBody(excerpt, { options: { ...excerpt.options, rows: POST_EDITOR_LAYOUT.excerptRows } }));
	}
	if (before.pending.includes("order")) {
		await client.post(`${FIELDS_PATH}/reorder`, { fieldSlugs: plan.order });
	}
	const after = inspectPostEditorLayout(fieldsFrom(await client.get(FIELDS_PATH)));
	if (after.status !== "ready") throw new Error(`posts editor layout postflight failed: ${[...after.problems, ...(after.pending ?? [])].join("; ")}`);
	return { action: "updated", before, after, plan };
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

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = checkedOrigin(args.origin, "--origin");
	const expectedOrigin = checkedOrigin(args.expectedOrigin, "--expected-origin");
	if (origin !== expectedOrigin) throw new Error(`Origin guard failed: target ${origin} does not match ${expectedOrigin}`);
	const token = process.env.EMDASH_TOKEN;
	if (!token?.startsWith("ec_pat_")) throw new Error("EMDASH_TOKEN must be an EmDash personal access token");
	if (args.apply && (!args.backupManifest || !args.receipt)) throw new Error("--apply requires --backup-manifest and --receipt");
	const backup = args.apply ? await loadBackupManifest(args.backupManifest, origin) : null;
	const startedAt = new Date().toISOString();
	const result = await ensurePostEditorLayout(new ApiClient(origin, token), { apply: args.apply });
	const receipt = {
		receiptVersion: 1,
		operation: "ensure-posts-editor-layout",
		origin,
		apply: args.apply,
		startedAt,
		completedAt: new Date().toISOString(),
		backup,
		request: POST_EDITOR_LAYOUT,
		action: result.action,
		plan: result.plan ?? null,
		before: result.before,
		after: result.after,
		contentRowsModified: 0,
		rollback: "Reorder with before.order, clear featured_image.widget, and drop excerpt.options.rows; restore the recorded D1 backup only if wider schema damage is observed.",
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
