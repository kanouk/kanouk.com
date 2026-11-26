#!/usr/bin/env node

// Puts the post editor in reading order: title, featured image (compact), excerpt (3 rows), body.
// Changes only field order, the featured image widget, and the excerpt's rows; no content rows.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ApiClient, checkedOrigin, loadBackupManifest } from "./ensure-related-album-field.mjs";
import { ensurePostEditorLayout, POST_EDITOR_LAYOUT } from "../src/utils/post-editor-layout.mjs";

export { desiredOrder, ensurePostEditorLayout, inspectPostEditorLayout, POST_EDITOR_LAYOUT } from "../src/utils/post-editor-layout.mjs";

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
