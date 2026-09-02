#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";

import { convertPostContent } from "./yohaku-transformers.mjs";

const EXPECTED_ORIGIN = "https://kanouk-emdash-staging.kanouk.workers.dev";
const SOURCE_FILES = {
	kanolog: "/Users/kanouk/Documents/Private_External_Imports/blog/wordpress.2026-07-10.xml",
	nocalog: "/Users/kanouk/Documents/Private_External_Imports/blog/nocalog-noca.WordPress.2026-07-10.xml",
	"art-quiz": "/Users/kanouk/Documents/Private_External_Imports/blog/11.WordPress.2026-07-10.xml",
};
const LEGACY_HOSTS = {
	"kanolog.net": "kanolog",
	"www.kanolog.net": "kanolog",
	"nocalog.net": "nocalog",
	"www.nocalog.net": "nocalog",
	"art-quiz.com": "art-quiz",
	"www.art-quiz.com": "art-quiz",
};

function parseArgs(argv) {
	const result = { apply: false, allMissing: false, contentIds: [], allowedPendingDraftIds: [] };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--apply") result.apply = true;
		else if (value === "--dry-run") result.apply = false;
		else if (value === "--all-missing") result.allMissing = true;
		else if (value === "--content-id") result.contentIds.push(String(argv[++index] || ""));
		else if (value === "--allow-pending-draft-id") result.allowedPendingDraftIds.push(String(argv[++index] || ""));
		else throw new Error(`Unknown argument: ${value}`);
	}
	result.contentIds = [...new Set(result.contentIds)];
	result.allowedPendingDraftIds = [...new Set(result.allowedPendingDraftIds)];
	if ((!result.allMissing && !result.contentIds.length) || result.contentIds.some((id) => !/^01[A-Z0-9]{24}$/.test(id))) {
		throw new Error("Use --all-missing or provide at least one valid --content-id");
	}
	if (!result.allMissing && result.allowedPendingDraftIds.some((id) => !result.contentIds.includes(id))) {
		throw new Error("--allow-pending-draft-id must also be selected with --content-id");
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

function cdata(value = "") {
	return value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)?.[1] ?? value;
}

function decodeHtml(value = "") {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#039;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replace(/\s+/g, " ")
		.trim();
}

function htmlAttribute(html, name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return html.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, "i"))?.[1] || "";
}

export function renderedLinkCards(html) {
	const cards = [];
	for (const match of html.matchAll(/<a\b(?=[^>]*\bclass=["'][^"']*\bp-blogCard__title\b[^"']*["'])[^>]*>([\s\S]*?)<\/a>/gi)) {
		const href = decodeHtml(htmlAttribute(match[0], "href"));
		if (!href) continue;
		cards.push({ _type: "yohaku.linkCard", id: href, title: decodeHtml(match[1]) || undefined });
	}
	return cards;
}

export function mergeSourceCards(sourceCards, renderedCards) {
	const length = Math.max(sourceCards.length, renderedCards.length);
	return Array.from({ length }, (_unused, index) => {
		const source = sourceCards[index] || {};
		const rendered = renderedCards[index] || {};
		const sourceTitle = String(source.title || "").trim();
		return {
			...rendered,
			...source,
			id: source.id || source.url || rendered.id || rendered.url || "",
			title: sourceTitle && sourceTitle !== "関連記事" ? sourceTitle : rendered.title || source.title,
		};
	});
}

export function wxrContentById(xml, wantedIds) {
	const result = new Map();
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = match[1];
		const id = cdata(item.match(/<wp:post_id>([\s\S]*?)<\/wp:post_id>/)?.[1] || "").trim();
		if (!wantedIds.has(id)) continue;
		const content = cdata(item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)?.[1] || "");
		result.set(id, content);
	}
	return result;
}

export function sourceLinkCards(content, siteId, postId) {
	return convertPostContent(
		{ id: postId, content },
		{
			siteId,
			dialogueProfiles: {},
			products: new Map(),
			reusableBlocks: new Map(),
			quizzes: new Map(),
		},
	).filter((node) => node?._type === "yohaku.linkCard");
}

function normalizeHref(value) {
	try {
		const url = new URL(value, "https://blog.kanouk.com");
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return String(value || "").trim();
	}
}

function hasMissingLinkCard(content) {
	let missing = false;
	const visit = (node) => {
		if (missing) return;
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		if (node._type === "yohaku.linkCard" && !String(node.id || node.url || "").trim()) {
			missing = true;
			return;
		}
		for (const value of Object.values(node)) visit(value);
	};
	visit(content);
	return missing;
}

function sourceReference(value) {
	const pseudo = String(value || "").match(/^wordpress:\/\/([^/]+)\/post\/(\d+)$/i);
	if (pseudo) return `${pseudo[1]}:${pseudo[2]}`;
	try {
		const url = new URL(value);
		const site = LEGACY_HOSTS[url.hostname.toLowerCase()];
		if (!site) return null;
		const postId = url.searchParams.get("p")
			|| url.pathname.match(/\/(?:stream|archives)\/(\d+)(?:\/|$)/)?.[1];
		return postId ? `${site}:${postId}` : null;
	} catch {
		return null;
	}
}

export function resolveSourceCard(card, sourceTargets) {
	const sourceId = sourceReference(card?.id || card?.url);
	const target = sourceId ? sourceTargets.get(sourceId) : null;
	if (target) {
		return {
			href: `/posts/${target.id}`,
			title: target.title || card.title,
			description: target.excerpt || undefined,
			imageUrl: target.featuredImage || undefined,
			caption: "あわせて読みたい",
		};
	}
	return {
		href: card?.id || card?.url || "",
		title: card?.title,
	};
}

export function publicFeaturedImage(value) {
	if (!value || typeof value !== "object") return undefined;
	if (typeof value.src === "string" && value.src.trim()) return value.src.trim();
	const storageKey = value.meta?.storageKey;
	if (value.provider === "local" && typeof storageKey === "string" && storageKey.trim()) {
		return `/_emdash/api/media/file/${encodeURIComponent(storageKey.trim())}`;
	}
	return undefined;
}

export function portableTextExcerpt(value, maxLength = 180) {
	const parts = [];
	const visit = (node) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		if (node._type === "span" && typeof node.text === "string") parts.push(node.text);
		else if (node._type === "block") visit(node.children);
	};
	visit(value);
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

export function repairLinkCards(content, sourceCards, sourceTargets) {
	let cardIndex = 0;
	let changedFields = 0;
	let repairedDestinations = 0;
	const repairedKeys = [];
	const visit = (node) => {
		if (Array.isArray(node)) return node.map(visit);
		if (!node || typeof node !== "object") return node;
		const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
		if (copy._type !== "yohaku.linkCard") return copy;
		const source = resolveSourceCard(sourceCards[cardIndex++], sourceTargets);
		if (!source.href) return copy;
		const currentHref = String(copy.id || copy.url || "").trim();
		const isMissing = !currentHref;
		const isSameDestination = normalizeHref(currentHref) === normalizeHref(source.href);
		if (!isMissing && !isSameDestination) return copy;
		if (isMissing) {
			copy.id = source.href;
			repairedDestinations++;
			changedFields++;
			repairedKeys.push(copy._key || "unknown");
		}
		for (const field of ["title", "description", "imageUrl", "caption"]) {
			const current = String(copy[field] || "").trim();
			const genericTitle = field === "title" && current === "関連記事";
			const staleMediaId = field === "imageUrl"
				&& /^\/_emdash\/api\/media\/file\/01[A-Z0-9]{24}$/.test(current);
			if ((!current || genericTitle || staleMediaId) && source[field]) {
				copy[field] = source[field];
				changedFields++;
			}
		}
		return copy;
	};
	return { value: visit(content), changedFields, repairedDestinations, repairedKeys };
}

async function listSourceTargets(origin, token) {
	const result = new Map();
	let cursor;
	do {
		const query = new URLSearchParams({ limit: "100" });
		if (cursor) query.set("cursor", cursor);
		const page = await request(origin, token, `/_emdash/api/content/posts?${query}`);
		for (const item of page?.items || []) {
			const sourceId = String(item.data?.source_id || "");
			if (!sourceId) continue;
			result.set(sourceId, {
				id: item.id,
				title: item.data?.title,
				excerpt: item.data?.excerpt || portableTextExcerpt(item.data?.content),
				featuredImage: publicFeaturedImage(item.data?.featured_image),
				content: item.data?.content,
			});
		}
		cursor = page?.nextCursor || undefined;
	} while (cursor);
	if (!result.size) throw new Error("Content listing did not expose source IDs");
	return result;
}

async function mapLimit(items, limit, task) {
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			await task(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function loadRenderedCards(sourceUrl) {
	let url;
	try { url = new URL(sourceUrl); } catch { return []; }
	if (!LEGACY_HOSTS[url.hostname.toLowerCase()]) return [];
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "kanouk-link-card-repair/1.0" },
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) return [];
		return renderedLinkCards(await response.text());
	} catch {
		return [];
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = process.env.EMDASH_URL;
	const token = process.env.EMDASH_TOKEN;
	if (origin !== EXPECTED_ORIGIN || !token?.startsWith("ec_pat_")) {
		throw new Error("Pinned EmDash origin and admin token are required through the guard wrapper");
	}

	const sourceTargets = await listSourceTargets(origin, token);
	if (args.allMissing) {
		for (const target of sourceTargets.values()) {
			if (hasMissingLinkCard(target.content)) args.contentIds.push(target.id);
		}
		args.contentIds = [...new Set(args.contentIds)];
	}
	if (!args.contentIds.length) throw new Error("No content with a missing link card was found");

	const selected = [];
	for (const id of args.contentIds) {
		const current = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		if (current.item?.status === "published" && current.item?.draftRevisionId && !args.allowedPendingDraftIds.includes(id)) {
			throw new Error(`${id} has a pending draft; inspect it before using --allow-pending-draft-id`);
		}
		const sourceId = String(current.item?.data?.source_id || "");
		const match = sourceId.match(/^([a-z0-9_-]+):(\d+)$/i);
		if (!match || !SOURCE_FILES[match[1]]) throw new Error(`${id} has an unsupported source_id: ${sourceId}`);
		selected.push({ id, current, siteId: match[1], sourcePostId: match[2] });
	}

	const sourceContents = new Map();
	for (const [siteId, file] of Object.entries(SOURCE_FILES)) {
		const wanted = new Set(selected.filter((item) => item.siteId === siteId).map((item) => item.sourcePostId));
		if (!wanted.size) continue;
		const xml = await fs.readFile(file, "utf8");
		for (const [id, content] of wxrContentById(xml, wanted)) sourceContents.set(`${siteId}:${id}`, content);
	}
	await mapLimit(selected, 6, async (item) => {
		item.renderedCards = await loadRenderedCards(item.current.item?.data?.source_url);
	});

	let updated = 0;
	let repairedDestinations = 0;
	for (const selectedItem of selected) {
		const { id, current, siteId, sourcePostId } = selectedItem;
		const sourceId = `${siteId}:${sourcePostId}`;
		const sourceContent = sourceContents.get(sourceId);
		if (sourceContent === undefined) throw new Error(`WXR content missing for ${sourceId}`);
		const cards = mergeSourceCards(
			sourceLinkCards(sourceContent, siteId, sourcePostId),
			selectedItem.renderedCards || [],
		);
		const repaired = repairLinkCards(current.item.data?.content || [], cards, sourceTargets);
		if (!repaired.changedFields) {
			console.log(`${id} unchanged`);
			continue;
		}
		if (!args.apply) {
			console.log(`${id} would_update fields=${repaired.changedFields} destinations=${repaired.repairedDestinations} keys=${repaired.repairedKeys.join(",")}`);
			repairedDestinations += repaired.repairedDestinations;
			continue;
		}
		await request(origin, token, `/_emdash/api/content/posts/${id}`, {
			method: "PUT",
			body: JSON.stringify({
				data: { ...current.item.data, content: repaired.value },
				_rev: current._rev,
			}),
		});
		if (current.item.status === "published") {
			await request(origin, token, `/_emdash/api/content/posts/${id}/publish`, {
				method: "POST",
				body: JSON.stringify({ publishedAt: current.item.publishedAt }),
			});
		}
		const verified = await request(origin, token, `/_emdash/api/content/posts/${id}`);
		const remaining = new Set(repaired.repairedKeys);
		const visit = (node) => {
			if (Array.isArray(node)) return node.forEach(visit);
			if (!node || typeof node !== "object") return;
			if (remaining.has(node._key) && String(node.id || node.url || "").trim()) remaining.delete(node._key);
			for (const value of Object.values(node)) visit(value);
		};
		visit(verified.item.data?.content || []);
		if (remaining.size) throw new Error(`${id} readback still has empty repaired link cards: ${[...remaining].join(",")}`);
		updated++;
		repairedDestinations += repaired.repairedDestinations;
		console.log(`${id} updated_verified fields=${repaired.changedFields} destinations=${repaired.repairedDestinations}`);
	}
	console.log(JSON.stringify({ apply: args.apply, selected: selected.length, updated, repairedDestinations }));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
