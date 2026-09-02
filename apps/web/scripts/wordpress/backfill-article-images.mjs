#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildProductMap, convertPostContent } from "./yohaku-transformers.mjs";
import {
	buildImportPlan,
	buildSmugMugMappings,
	rewriteSmugMugReferences,
} from "./import-wxr.mjs";

const EXPECTED_ORIGIN = "https://kanouk-emdash-staging.kanouk.workers.dev";
const MANIFEST_ROOT = path.resolve("../../migration/smugmug/albums");

function parseArgs(argv) {
	const result = { apply: false, allSmugMug: false, contentIds: [], allowedPendingDraftIds: [] };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--apply") result.apply = true;
		else if (value === "--dry-run") result.apply = false;
		else if (value === "--all-smugmug") result.allSmugMug = true;
		else if (value === "--content-id") result.contentIds.push(String(argv[++index] || ""));
		else if (value === "--allow-pending-draft-id") result.allowedPendingDraftIds.push(String(argv[++index] || ""));
		else throw new Error(`Unknown argument: ${value}`);
	}
	result.contentIds = [...new Set(result.contentIds)];
	result.allowedPendingDraftIds = [...new Set(result.allowedPendingDraftIds)];
	if ((!result.allSmugMug && !result.contentIds.length) || result.contentIds.some((id) => !/^01[A-Z0-9]{24}$/.test(id))) {
		throw new Error("Use --all-smugmug or provide at least one valid --content-id");
	}
	if (result.allowedPendingDraftIds.some((id) => !/^01[A-Z0-9]{24}$/.test(id))) {
		throw new Error("--allow-pending-draft-id must be a valid content ID");
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

async function loadManifests(root = MANIFEST_ROOT) {
	const manifests = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const filename = path.join(root, entry.name, "manifest.json");
		try { manifests.push(JSON.parse(await fs.readFile(filename, "utf8"))); }
		catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
	return manifests;
}

function addIndexKey(index, key, value) {
	if (typeof key !== "string" || !key) return;
	for (const candidate of new Set([key, decodeURIComponent(key), key.split("/").at(-1)])) {
		if (candidate) index.set(candidate, value);
	}
}

export function buildArticleImageIndex(manifests) {
	const index = new Map();
	for (const manifest of manifests) {
		for (const asset of manifest?.assets || []) {
			const destination = asset?.destination || {};
			const photoId = String(asset?.id || destination.photo_path?.split("/").filter(Boolean).at(-1) || "");
			if (!photoId || !destination.emdash_media_id || !destination.r2_object_key) continue;
			const value = {
				photoId,
				photoTarget: `https://photos.kanouk.com/p/${encodeURIComponent(photoId)}`,
				caption: String(asset?.display?.caption || asset?.display?.title || "").trim(),
			};
			for (const key of [
				destination.emdash_media_id,
				destination.media_path,
				destination.r2_object_key,
				`/_emdash/api/media/file/${encodeURIComponent(destination.r2_object_key)}`,
			]) addIndexKey(index, key, value);
		}
	}
	return index;
}

export function articleImageMapping(node, index) {
	for (const value of [node?.asset?._ref, node?.asset?.url]) {
		if (typeof value !== "string") continue;
		for (const candidate of [value, decodeURIComponent(value), value.split("/").at(-1)]) {
			const match = index.get(candidate);
			if (match) return match;
		}
	}
	return undefined;
}

function replaceablePhotoLink(value) {
	if (!String(value || "").trim()) return true;
	try {
		const url = new URL(value, "https://blog.kanouk.com");
		return ["kanolog.smugmug.com", "photos.smugmug.com"].includes(url.hostname.toLowerCase())
			|| (url.hostname.toLowerCase() === "photos.kanouk.com" && /^\/(?:p|photos)\//.test(url.pathname));
	} catch { return false; }
}

export function repairArticleImages(content, desiredByKey, imageIndex) {
	const counts = { images: 0, links: 0, widths: 0, frames: 0, captions: 0 };
	const changedKeys = new Set();
	const visit = (node) => {
		if (Array.isArray(node)) return node.map(visit);
		if (!node || typeof node !== "object") return node;
		const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
		if (copy._type !== "image") return copy;
		const mapping = articleImageMapping(copy, imageIndex);
		if (!mapping) return copy;
		counts.images++;
		// Admin round-trips can regenerate Portable Text keys. Fall back to the
		// stable migrated photo identity so a pending draft still receives the
		// source image's width, frame, and caption without replacing its prose.
		const desired = desiredByKey.get(String(copy._key || ""))
			|| desiredByKey.get(`photo:${mapping.photoId}`)
			|| {};
		const mark = () => changedKeys.add(String(copy._key || "unknown"));
		if (replaceablePhotoLink(copy.link) && copy.link !== mapping.photoTarget) {
			copy.link = mapping.photoTarget;
			counts.links++;
			mark();
		}
		if (Number.isFinite(desired.displayWidth) && desired.displayWidth > 0 && copy.displayWidth !== desired.displayWidth) {
			copy.displayWidth = desired.displayWidth;
			counts.widths++;
			mark();
		}
		const visualStyle = desired.visualStyle || "photo-frame";
		if (copy.visualStyle !== visualStyle) {
			copy.visualStyle = visualStyle;
			counts.frames++;
			mark();
		}
		const caption = String(desired.caption || mapping.caption || "").trim();
		if (caption && copy.caption !== caption) {
			copy.caption = caption;
			counts.captions++;
			mark();
		}
		return copy;
	};
	return { value: visit(content), counts, changedKeys: [...changedKeys] };
}

async function listPosts(origin, token) {
	const items = [];
	let cursor;
	do {
		const query = new URLSearchParams({ limit: "100" });
		if (cursor) query.set("cursor", cursor);
		const page = await request(origin, token, `/_emdash/api/content/posts?${query}`);
		items.push(...(page?.items || []));
		cursor = page?.nextCursor || undefined;
	} while (cursor);
	return items;
}

function sourceImages(record, mappings) {
	const reusableBlocks = new Map(
		record.wxr.posts.filter((candidate) => candidate.postType === "wp_block").map((candidate) => [String(candidate.id), candidate]),
	);
	const converted = convertPostContent(record.post, {
		siteId: record.source.id,
		dialogueProfiles: record.source.dialogueProfiles || {},
		products: buildProductMap(record.wxr.posts),
		reusableBlocks,
		quizzes: new Map(),
	});
	const rewritten = rewriteSmugMugReferences(converted, mappings).value;
	const result = new Map();
	for (const node of rewritten.filter((item) => item?._type === "image")) {
		result.set(String(node._key || ""), node);
		const photoId = String(node.link || "").match(/photos\.kanouk\.com\/p\/([^/?#]+)/)?.[1];
		if (photoId) result.set(`photo:${decodeURIComponent(photoId)}`, node);
	}
	return result;
}

function addCounts(target, value) {
	for (const key of Object.keys(target)) target[key] += value[key] || 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = process.env.EMDASH_URL;
	const token = process.env.EMDASH_TOKEN;
	if (origin !== EXPECTED_ORIGIN || !token?.startsWith("ec_pat_")) {
		throw new Error("Pinned EmDash origin and admin token are required through the guard wrapper");
	}
	const manifests = await loadManifests();
	const imageIndex = buildArticleImageIndex(manifests);
	const smugMugMappings = buildSmugMugMappings(manifests);
	const { records } = await buildImportPlan();
	const recordsBySourceId = new Map(records.map((record) => [`${record.source.id}:${record.post.id}`, record]));
	const listed = await listPosts(origin, token);
	const selectedIds = new Set(args.contentIds);
	if (args.allSmugMug) {
		for (const item of listed) {
			if ((item.data?.content || []).some((node) => node?._type === "image" && articleImageMapping(node, imageIndex))) selectedIds.add(item.id);
		}
	}
	if (!selectedIds.size) throw new Error("No posts with migrated SmugMug images were found");

	const totals = { images: 0, links: 0, widths: 0, frames: 0, captions: 0 };
	let updated = 0;
	for (const id of selectedIds) {
		const current = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		if (current.item?.status === "published" && current.item?.draftRevisionId && !args.allowedPendingDraftIds.includes(id)) {
			throw new Error(`${id} has a pending draft; inspect it before using --allow-pending-draft-id`);
		}
		const sourceId = String(current.item?.data?.source_id || "");
		const record = recordsBySourceId.get(sourceId);
		if (!record) throw new Error(`${id} has no matching WordPress source record: ${sourceId}`);
		const repaired = repairArticleImages(current.item.data?.content || [], sourceImages(record, smugMugMappings), imageIndex);
		addCounts(totals, repaired.counts);
		if (!repaired.changedKeys.length) {
			console.log(`${id} unchanged images=${repaired.counts.images}`);
			continue;
		}
		if (!args.apply) {
			console.log(`${id} would_update keys=${repaired.changedKeys.join(",")} counts=${JSON.stringify(repaired.counts)}`);
			continue;
		}
		await request(origin, token, `/_emdash/api/content/posts/${id}`, {
			method: "PUT",
			body: JSON.stringify({ data: { ...current.item.data, content: repaired.value }, _rev: current._rev }),
		});
		if (current.item.status === "published") {
			await request(origin, token, `/_emdash/api/content/posts/${id}/publish`, {
				method: "POST",
				body: JSON.stringify({ publishedAt: current.item.publishedAt }),
			});
		}
		const verified = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		const verifiedRepair = repairArticleImages(verified.item.data?.content || [], sourceImages(record, smugMugMappings), imageIndex);
		if (verifiedRepair.changedKeys.length) throw new Error(`${id} failed readback: ${verifiedRepair.changedKeys.join(",")}`);
		updated++;
		console.log(`${id} updated_verified counts=${JSON.stringify(repaired.counts)}`);
	}
	console.log(JSON.stringify({ apply: args.apply, selected: selectedIds.size, updated, ...totals }));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
