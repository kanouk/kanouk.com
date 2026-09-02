#!/usr/bin/env node

import process from "node:process";

const EXPECTED_ORIGIN = "https://kanouk-emdash-staging.kanouk.workers.dev";
const KANO = {
	speaker: "カノ",
	avatarUrl: "/_emdash/api/media/file/01M1DCHMFS2464PPJN2QMS64EZ.png",
	avatarShape: "square",
};
const NOCA = {
	speaker: "noca",
	avatarUrl: "/_emdash/api/media/file/01M1DEEC9M58NB6XZNFPGM52PE.png",
	avatarShape: "circle",
};

function parseArgs(argv) {
	const result = { apply: false, contentIds: [] };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--apply") result.apply = true;
		else if (value === "--dry-run") result.apply = false;
		else if (value === "--content-id") result.contentIds.push(String(argv[++index] || ""));
		else throw new Error(`Unknown argument: ${value}`);
	}
	if (!result.contentIds.length || result.contentIds.some((id) => !/^01[A-Z0-9]{24}$/.test(id))) {
		throw new Error("At least one valid --content-id is required");
	}
	return result;
}

async function request(origin, token, pathname, options = {}) {
	const response = await fetch(origin + pathname, {
		...options,
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

function profileFor(sourceId, node) {
	if (node?._type !== "yohaku.dialogue") return null;
	if (String(node.avatarUrl || "").includes("01M1DEEC9M58NB6XZNFPGM52PE")) return NOCA;
	if (sourceId.startsWith("kanolog:") && node.sourceSpeakerId === "5877") return KANO;
	if (sourceId.startsWith("nocalog:") && node.sourceSpeakerId === "5877") return KANO;
	if (sourceId.startsWith("nocalog:") && node.sourceSpeakerId === "1") return NOCA;
	return null;
}

function enrichDialogues(value, sourceId) {
	let changes = 0;
	const visit = (node) => {
		if (Array.isArray(node)) return node.map(visit);
		if (!node || typeof node !== "object") return node;
		const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
		const profile = profileFor(sourceId, copy);
		if (!profile) return copy;
		for (const [key, profileValue] of Object.entries(profile)) {
			if (!copy[key]) {
				copy[key] = profileValue;
				changes++;
			}
		}
		if (!copy.align) copy.align = "left";
		if (!copy.bubbleStyle) copy.bubbleStyle = "speaking";
		return copy;
	};
	return { value: visit(value), changes };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = process.env.EMDASH_URL;
	const token = process.env.EMDASH_TOKEN;
	if (origin !== EXPECTED_ORIGIN || !token?.startsWith("ec_pat_")) {
		throw new Error("Pinned EmDash origin and admin token are required through the guard wrapper");
	}
	let updated = 0;
	for (const id of args.contentIds) {
		const current = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		const item = current.item;
		const sourceId = String(item.data?.source_id || "");
		const enriched = enrichDialogues(item.data?.content || [], sourceId);
		if (!enriched.changes) {
			console.log(`${id} unchanged`);
			continue;
		}
		if (!args.apply) {
			console.log(`${id} would_update (${enriched.changes} fields)`);
			continue;
		}
		await request(origin, token, `/_emdash/api/content/posts/${id}`, {
			method: "PUT",
			body: JSON.stringify({
				data: { ...item.data, content: enriched.value },
				_rev: current._rev,
			}),
		});
		if (item.status === "published") {
			await request(origin, token, `/_emdash/api/content/posts/${id}/publish`, {
				method: "POST",
				body: JSON.stringify({ publishedAt: item.publishedAt }),
			});
		}
		const verified = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		const remaining = enrichDialogues(verified.item.data?.content || [], sourceId).changes;
		if (remaining) throw new Error(`${id} readback still needs ${remaining} dialogue fields`);
		updated++;
		console.log(`${id} updated_verified`);
	}
	console.log(JSON.stringify({ apply: args.apply, selected: args.contentIds.length, updated }));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
