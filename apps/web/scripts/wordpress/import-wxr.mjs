#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseWxrDate, parseWxrString } from "emdash";

import { buildProductMap, convertPostContent } from "./yohaku-transformers.mjs";

const DEFAULT_SOURCES = [
	{
		id: "kanolog",
		origin: "https://kanolog.net",
		file: "/Users/kanouk/Documents/Private_External_Imports/blog/wordpress.2026-07-10.xml",
		bylineSlug: "kanouk",
		bylineName: "カノ",
	},
	{
		id: "nocalog",
		origin: "https://nocalog.net",
		file: "/Users/kanouk/Documents/Private_External_Imports/blog/nocalog-noca.WordPress.2026-07-10.xml",
		bylineSlug: "noca",
		bylineName: "noca",
	},
	{
		id: "art-quiz",
		origin: "https://art-quiz.com",
		file: "/Users/kanouk/Documents/Private_External_Imports/blog/11.WordPress.2026-07-10.xml",
		bylineSlug: "artquiz",
		bylineName: "artquiz",
	},
];

const TARGET_ORIGIN = "https://blog.kanouk.com";
const DEFAULT_LEDGER = path.resolve("../../migration/wordpress/runtime/import-ledger.json");
const DEFAULT_MEDIA_LEDGER = path.resolve("../../migration/wordpress/runtime/media-ledger.json");
const PUBLISHED_STATUS = "publish";
const CONTENT_TYPES = new Set(["post", "page"]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const MAX_REQUEST_ATTEMPTS = 5;

export function shouldRetryRequest({ status, error, method = "GET" }) {
	if (status !== undefined) return TRANSIENT_HTTP_STATUSES.has(status);
	return Boolean(error) && ["GET", "HEAD", "PUT"].includes(method.toUpperCase());
}

function retryDelayMs(attempt, retryAfter) {
	const retryAfterSeconds = Number(retryAfter);
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
		return Math.min(retryAfterSeconds * 1000, 10_000);
	}
	const exponential = Math.min(400 * 2 ** (attempt - 1), 6_400);
	return exponential + Math.floor(Math.random() * 250);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArgs(argv) {
	const args = {
		apply: false,
		concurrency: 6,
		ledger: DEFAULT_LEDGER,
		mediaLedger: DEFAULT_MEDIA_LEDGER,
		limit: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i];
		if (value === "--apply") args.apply = true;
		else if (value === "--dry-run") args.apply = false;
		else if (value === "--concurrency") args.concurrency = Number(argv[++i]);
		else if (value === "--limit") args.limit = Number(argv[++i]);
		else if (value === "--ledger") args.ledger = path.resolve(argv[++i]);
		else if (value === "--media-ledger") args.mediaLedger = path.resolve(argv[++i]);
		else throw new Error(`Unknown argument: ${value}`);
	}
	if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12) {
		throw new Error("--concurrency must be an integer from 1 to 12");
	}
	if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
		throw new Error("--limit must be a positive integer");
	}
	return args;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function decodeXmlValue(value = "") {
	const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)?.[1];
	return (cdata ?? value)
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.trim();
}

export function extractModifiedDates(xml) {
	const result = new Map();
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = match[1];
		const id = decodeXmlValue(item.match(/<wp:post_id>([\s\S]*?)<\/wp:post_id>/)?.[1]);
		const local = decodeXmlValue(item.match(/<wp:post_modified>([\s\S]*?)<\/wp:post_modified>/)?.[1]);
		const gmt = decodeXmlValue(item.match(/<wp:post_modified_gmt>([\s\S]*?)<\/wp:post_modified_gmt>/)?.[1]);
		if (id) result.set(id, { local: local || undefined, gmt: gmt || undefined });
	}
	return result;
}

export function assignDestinationSlugs(records) {
	const counts = new Map();
	for (const record of records) {
		const sourceSlug = String(record.post.postName || "");
		if (!sourceSlug) continue;
		const key = `${record.post.postType}:${sourceSlug}`;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	return records.map((record) => {
		const sourceSlug = String(record.post.postName || "");
		const key = `${record.post.postType}:${sourceSlug}`;
		const slug = !sourceSlug
			? `wp-${record.source.id}-${record.post.id}`
			: counts.get(key) > 1
				? `${sourceSlug}-${record.source.id}`
				: sourceSlug;
		return { ...record, slug };
	});
}

function flattenTerms(terms) {
	return terms.flatMap((term) => [term, ...flattenTerms(Array.isArray(term.children) ? term.children : [])]);
}

function sourceUrl(record) {
	return record.post.link || `${record.source.origin}/?p=${record.post.id}`;
}

function targetPath(record) {
	return `/${record.post.postType === "page" ? "pages" : "posts"}/${record.slug}`;
}

function buildAttachmentMap(wxr) {
	return new Map(wxr.attachments.filter((item) => item.id && item.url).map((item) => [String(item.id), item.url]));
}

function normalizedMediaUrl(url) {
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return String(url).split(/[?#]/, 1)[0];
	}
}

function stripWordPressSize(url) {
	return url.replace(/-\d+x\d+(?=\.[^./?#]+$)/, "");
}

export function buildMediaMappings(ledger = {}) {
	const exact = new Map();
	const normalized = new Map();
	for (const item of Object.values(ledger.items || {})) {
		if (!item || item.status !== "verified" || !item.public_path || !item.media_id) continue;
		const mapping = {
			publicPath: item.public_path,
			mediaId: item.media_id,
			alt: item.alt || item.title || "",
		};
		for (const sourceUrl of new Set([item.url, ...(item.aliases || [])])) {
			if (typeof sourceUrl !== "string" || !sourceUrl) continue;
			exact.set(sourceUrl, mapping);
			const base = normalizedMediaUrl(sourceUrl);
			normalized.set(base, mapping);
			normalized.set(stripWordPressSize(base), mapping);
		}
	}
	return { exact, normalized };
}

function findMediaMapping(url, mappings) {
	return mappings.exact.get(url)
		|| mappings.normalized.get(normalizedMediaUrl(url))
		|| mappings.normalized.get(stripWordPressSize(normalizedMediaUrl(url)));
}

function rewriteStringMedia(value, mappings) {
	let rewrites = 0;
	const rewritten = value.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
		const trailing = raw.match(/[),.;:!?]+$/)?.[0] || "";
		const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
		const mapping = findMediaMapping(candidate, mappings);
		if (!mapping) return raw;
		rewrites++;
		return mapping.publicPath + trailing;
	});
	return { value: rewritten, rewrites };
}

export function rewriteMediaReferences(value, mappings) {
	let rewrites = 0;
	const visit = (node) => {
		if (Array.isArray(node)) return node.map(visit);
		if (!node || typeof node !== "object") return node;
		const copy = Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
		if (copy._type === "image" && copy.asset && typeof copy.asset === "object") {
			const sourceUrl = typeof node.asset?.url === "string" ? node.asset.url : "";
			const mapping = sourceUrl ? findMediaMapping(sourceUrl, mappings) : undefined;
			if (mapping) {
				copy.asset = { ...copy.asset, _type: "reference", _ref: mapping.mediaId, url: mapping.publicPath, provider: "local" };
				rewrites++;
			}
		}
		return copy;
	};
	const replaceStrings = (node) => {
		if (typeof node === "string") {
			const result = rewriteStringMedia(node, mappings);
			rewrites += result.rewrites;
			return result.value;
		}
		if (Array.isArray(node)) return node.map(replaceStrings);
		if (node && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, replaceStrings(child)]));
		}
		return node;
	};
	return { value: replaceStrings(visit(value)), rewrites };
}

function countType(nodes, type) {
	let total = 0;
	const visit = (value) => {
		if (Array.isArray(value)) for (const item of value) visit(item);
		else if (value && typeof value === "object") {
			if (value._type === type) total++;
			for (const nested of Object.values(value)) visit(nested);
		}
	};
	visit(nodes);
	return total;
}

function migrationData(record, taxonomySlugs, mediaMappings) {
	const { post, source, wxr, modified } = record;
	const reusableBlocks = new Map(
		wxr.posts.filter((candidate) => candidate.postType === "wp_block").map((candidate) => [String(candidate.id), candidate]),
	);
	const convertedContent = convertPostContent(post, {
		siteId: source.id,
		products: buildProductMap(wxr.posts),
		reusableBlocks,
	});
	const mediaRewrite = rewriteMediaReferences(convertedContent, mediaMappings);
	const content = mediaRewrite.value;
	const collection = post.postType === "page" ? "pages" : "posts";
	const oldUrl = sourceUrl(record);
	const targetUrl = TARGET_ORIGIN + targetPath(record);
	const date = parseWxrDate(post.postDateGmt, post.pubDate, post.postDate)?.toISOString();
	const baseMetadata = {
		system: "wordpress",
		site: source.id,
		wordpress_id: String(post.id),
		wordpress_type: post.postType,
		wordpress_status: post.status || "unknown",
		wordpress_slug: post.postName || "",
		creator: post.creator || "",
		guid: post.guid || "",
		comment_status: post.commentStatus || "",
		ping_status: post.pingStatus || "",
		menu_order: post.menuOrder || 0,
		modified_local: modified?.local,
		modified_gmt: modified?.gmt,
		html_block_count: countType(content, "htmlBlock"),
		media_rewrite_count: mediaRewrite.rewrites,
	};
	const data = {
		title: post.title || "無題",
		content,
		source_url: oldUrl,
		source_id: `${source.id}:${post.id}`,
		source_metadata: baseMetadata,
	};
	if (collection === "posts") {
		data.excerpt = post.excerpt || undefined;
		const attachmentUrl = record.attachmentMap.get(String(post.meta.get("_thumbnail_id") || ""));
		if (attachmentUrl) {
			const mapping = findMediaMapping(attachmentUrl, mediaMappings);
			data.featured_image = mapping
				? { id: mapping.mediaId, provider: "local", alt: mapping.alt }
				: attachmentUrl;
		}
	}
	const taxonomies = collection === "posts" ? {
		category: [...new Set((post.categories || []).map((slug) => taxonomySlugs.get(`category:${slug}`) || slug))],
		tag: [...new Set((post.tags || []).map((slug) => taxonomySlugs.get(`tag:${slug}`) || slug))],
	} : {};
	const desired = {
		collection,
		slug: record.slug,
		status: post.status === PUBLISHED_STATUS ? "published" : "draft",
		createdAt: date,
		publishedAt: post.status === PUBLISHED_STATUS ? date : undefined,
		data,
		taxonomies,
		seo: {
			canonical: targetUrl,
			noIndex: post.status !== PUBLISHED_STATUS,
		},
	};
	const fingerprint = sha256(stableJson(desired));
	desired.data.source_metadata = { ...baseMetadata, migration_fingerprint: fingerprint };
	return { ...desired, fingerprint, oldUrl, targetUrl };
}

class ApiClient {
	constructor(origin, token) {
		this.origin = origin.replace(/\/$/, "");
		this.token = token;
	}

	async request(pathname, options = {}, allowed = []) {
		const method = (options.method || "GET").toUpperCase();
		for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
			let response;
			try {
				response = await fetch(this.origin + pathname, {
					...options,
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/json",
						...(options.body ? { "Content-Type": "application/json" } : {}),
						...options.headers,
					},
				});
			} catch (error) {
				if (attempt === MAX_REQUEST_ATTEMPTS || !shouldRetryRequest({ error, method })) throw error;
				await sleep(retryDelayMs(attempt));
				continue;
			}
			let payload;
			try { payload = await response.json(); } catch { payload = undefined; }
			if (!response.ok && !allowed.includes(response.status)) {
				if (attempt < MAX_REQUEST_ATTEMPTS && shouldRetryRequest({ status: response.status, method })) {
					await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
					continue;
				}
				const code = payload?.error?.code || `HTTP_${response.status}`;
				const message = payload?.error?.message || "Request failed";
				throw new Error(`${code}: ${message}`);
			}
			return { status: response.status, data: payload?.data, payload };
		}
		throw new Error("Request retry loop exhausted");
	}

	get(pathname, allowed) { return this.request(pathname, {}, allowed); }
	post(pathname, body) { return this.request(pathname, { method: "POST", body: JSON.stringify(body) }); }
	put(pathname, body) { return this.request(pathname, { method: "PUT", body: JSON.stringify(body) }); }
}

async function ensureBylines(client, sources, apply) {
	const response = await client.get("/_emdash/api/admin/bylines?limit=100");
	const existing = new Map((response.data?.items || []).map((item) => [item.slug, item]));
	const result = new Map();
	for (const source of sources) {
		let byline = existing.get(source.bylineSlug);
		if (!byline && apply) {
			const created = await client.post("/_emdash/api/admin/bylines", {
				slug: source.bylineSlug,
				displayName: source.bylineName,
				isGuest: false,
			});
			byline = created.data;
		}
		result.set(source.id, byline?.id || null);
	}
	return result;
}

async function ensureSchema(client, apply) {
	const response = await client.get("/_emdash/api/schema");
	const collections = new Map((response.data?.collections || []).map((collection) => [collection.slug, collection]));
	for (const collectionSlug of ["posts", "pages"]) {
		const collection = collections.get(collectionSlug);
		if (!collection) throw new Error(`Required collection is missing: ${collectionSlug}`);
		const existing = new Set((collection.fields || []).map((field) => field.slug));
		for (const field of [
			{ slug: "source_url", label: "Source URL", type: "string", indexed: true },
			{ slug: "source_id", label: "Source ID", type: "string", indexed: true },
			{ slug: "source_metadata", label: "Source Metadata", type: "json" },
		]) {
			if (!existing.has(field.slug) && apply) {
				await client.post(`/_emdash/api/schema/collections/${collectionSlug}/fields`, field);
			}
		}
	}
}

async function ensureTaxonomies(client, loadedSources, apply) {
	const definitions = await client.get("/_emdash/api/taxonomies");
	const existingDefs = new Map((definitions.data?.taxonomies || []).map((item) => [item.name, item]));
	for (const definition of [
		{ name: "category", label: "カテゴリー", labelSingular: "カテゴリー", hierarchical: true },
		{ name: "tag", label: "タグ", labelSingular: "タグ", hierarchical: false },
	]) {
		if (!existingDefs.has(definition.name) && apply) {
			await client.post("/_emdash/api/taxonomies", { ...definition, collections: ["posts"] });
		}
	}

	const desired = new Map();
	for (const { wxr } of loadedSources) {
		for (const term of wxr.categories) desired.set(`category:${term.nicename}`, { taxonomy: "category", slug: term.nicename, label: term.name });
		for (const term of wxr.tags) desired.set(`tag:${term.slug}`, { taxonomy: "tag", slug: term.slug, label: term.name });
	}
	const mapping = new Map();
	for (const taxonomy of ["category", "tag"]) {
		const listed = await client.get(`/_emdash/api/taxonomies/${taxonomy}/terms?includeCounts=false`);
		const existing = new Map(flattenTerms(listed.data?.terms || []).map((term) => [term.slug, term]));
		for (const term of [...desired.values()].filter((item) => item.taxonomy === taxonomy).sort((a, b) => a.slug.localeCompare(b.slug))) {
			mapping.set(`${taxonomy}:${term.slug}`, term.slug);
			if (!existing.has(term.slug) && apply) {
				await client.post(`/_emdash/api/taxonomies/${taxonomy}/terms`, { slug: term.slug, label: term.label });
			}
		}
	}
	return mapping;
}

async function getContent(client, collection, slug) {
	const response = await client.get(`/_emdash/api/content/${collection}/${encodeURIComponent(slug)}`, [404]);
	return response.status === 404 ? null : response.data;
}

function contentBody(desired, bylineId) {
	return {
		data: desired.data,
		slug: desired.slug,
		...(desired.status === "draft" ? { status: "draft" } : {}),
		...(bylineId ? { bylines: [{ bylineId }] } : {}),
		...(Object.keys(desired.taxonomies).length ? { taxonomies: desired.taxonomies } : {}),
		seo: desired.seo,
		createdAt: desired.createdAt,
		publishedAt: desired.publishedAt,
	};
}

async function upsertContent(client, record, desired, bylineId, apply) {
	const current = await getContent(client, desired.collection, desired.slug);
	const currentFingerprint = current?.item?.data?.source_metadata?.migration_fingerprint;
	if (currentFingerprint === desired.fingerprint && current.item.status === desired.status) return "skipped_verified";
	if (!apply) return current ? "would_update" : "would_create";
	if (!current) {
		const created = await client.post(`/_emdash/api/content/${desired.collection}`, contentBody(desired, bylineId));
		if (desired.status === "published") {
			await client.post(
				`/_emdash/api/content/${desired.collection}/${encodeURIComponent(created.data.item.id)}/publish`,
				{ publishedAt: desired.publishedAt },
			);
		}
		return "created";
	}
	await client.put(`/_emdash/api/content/${desired.collection}/${encodeURIComponent(current.item.id)}`, {
		data: desired.data,
		slug: desired.slug,
		...(desired.status === "draft" ? { status: "draft" } : {}),
		...(bylineId ? { bylines: [{ bylineId }] } : {}),
		...(Object.keys(desired.taxonomies).length ? { taxonomies: desired.taxonomies } : {}),
		seo: desired.seo,
		publishedAt: desired.publishedAt,
		_rev: current._rev,
	});
	if (desired.status === "published" && current.item.status !== "published") {
		await client.post(`/_emdash/api/content/${desired.collection}/${encodeURIComponent(current.item.id)}/publish`, { publishedAt: desired.publishedAt });
	} else if (desired.status === "draft" && current.item.status === "published") {
		await client.post(`/_emdash/api/content/${desired.collection}/${encodeURIComponent(current.item.id)}/unpublish`, {});
	}
	return "updated";
}

async function upsertUrlMapping(client, desired, record, apply) {
	const slug = `wp-${sha256(desired.oldUrl).slice(0, 24)}`;
	const current = await getContent(client, "url_mappings", slug);
	const data = {
		source_url: desired.oldUrl,
		target_url: desired.targetUrl,
		target_kind: desired.collection === "posts" ? "post" : "page",
		source_system: "wordpress",
		source_record_id: `${record.source.id}:${record.post.id}`,
		migration_status: "imported",
		verified: false,
	};
	if (current?.item?.data?.target_url === desired.targetUrl && current.item.status === "published") return;
	if (!apply) return;
	if (!current) {
		const created = await client.post("/_emdash/api/content/url_mappings", { data, slug });
		await client.post(`/_emdash/api/content/url_mappings/${encodeURIComponent(created.data.item.id)}/publish`, {});
	} else {
		await client.put(`/_emdash/api/content/url_mappings/${encodeURIComponent(current.item.id)}`, { data, slug, _rev: current._rev });
		if (current.item.status !== "published") {
			await client.post(`/_emdash/api/content/url_mappings/${encodeURIComponent(current.item.id)}/publish`, {});
		}
	}
}

async function mapLimit(items, limit, task) {
	const results = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await task(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

async function loadSources(sources = DEFAULT_SOURCES) {
	const loaded = [];
	for (const source of sources) {
		const xml = await fs.readFile(source.file, "utf8");
		const wxr = await parseWxrString(xml);
		loaded.push({ ...source, xml, wxr, modifiedDates: extractModifiedDates(xml), attachmentMap: buildAttachmentMap(wxr) });
	}
	return loaded;
}

export async function buildImportPlan(sources = DEFAULT_SOURCES) {
	const loadedSources = await loadSources(sources);
	const records = [];
	for (const source of loadedSources) {
		for (const post of source.wxr.posts.filter((item) => CONTENT_TYPES.has(item.postType))) {
			records.push({
				source,
				wxr: source.wxr,
				post,
				modified: source.modifiedDates.get(String(post.id)),
				attachmentMap: source.attachmentMap,
			});
		}
	}
	return { loadedSources, records: assignDestinationSlugs(records) };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const origin = process.env.EMDASH_URL;
	const token = process.env.EMDASH_TOKEN;
	if (!origin || !token || origin !== "https://kanouk-emdash-staging.kanouk.workers.dev" || !token.startsWith("ec_pat_")) {
		throw new Error("Pinned EmDash URL and token are required through the guard wrapper");
	}
	const client = new ApiClient(origin, token);
	const { loadedSources, records: allRecords } = await buildImportPlan();
	let mediaLedger = {};
	try { mediaLedger = JSON.parse(await fs.readFile(args.mediaLedger, "utf8")); } catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const mediaMappings = buildMediaMappings(mediaLedger);
	const records = args.limit ? allRecords.slice(0, args.limit) : allRecords;
	await ensureSchema(client, args.apply);
	const bylines = await ensureBylines(client, DEFAULT_SOURCES, args.apply);
	const taxonomySlugs = await ensureTaxonomies(client, loadedSources, args.apply);
	const counts = {};
	const failures = [];
	const ledgerItems = [];
	await mapLimit(records, args.concurrency, async (record, index) => {
		try {
			const desired = migrationData(record, taxonomySlugs, mediaMappings);
			const status = await upsertContent(client, record, desired, bylines.get(record.source.id), args.apply);
			await upsertUrlMapping(client, desired, record, args.apply);
			counts[status] = (counts[status] || 0) + 1;
			ledgerItems[index] = {
				source_site: record.source.id,
				source_id: String(record.post.id),
				source_url: desired.oldUrl,
				source_status: record.post.status,
				target_collection: desired.collection,
				target_slug: desired.slug,
				target_url: desired.targetUrl,
				migration_fingerprint: desired.fingerprint,
				result: status,
			};
			console.log(`[${index + 1}/${records.length}] ${record.source.id}:${record.post.id} ${status}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({ source_site: record.source.id, source_id: String(record.post.id), error: message });
			console.error(`[${index + 1}/${records.length}] ${record.source.id}:${record.post.id} failed: ${message}`);
		}
	});
	const ledger = {
		version: 1,
		generated_at: new Date().toISOString(),
		apply: args.apply,
		source_files: loadedSources.map((source) => ({ id: source.id, path: source.file, sha256: sha256(source.xml) })),
		counts: {
			total_available: allRecords.length,
			selected: records.length,
			by_type: Object.fromEntries([...Map.groupBy(allRecords, (record) => record.post.postType).entries()].map(([key, value]) => [key, value.length])),
			by_status: Object.fromEntries([...Map.groupBy(allRecords, (record) => record.post.status || "unknown").entries()].map(([key, value]) => [key, value.length])),
			results: counts,
			failed: failures.length,
		},
		items: ledgerItems.filter(Boolean),
		failures,
	};
	await fs.mkdir(path.dirname(args.ledger), { recursive: true });
	await fs.writeFile(args.ledger, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
	console.log(JSON.stringify({ apply: args.apply, ...ledger.counts, ledger: args.ledger }));
	if (failures.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
