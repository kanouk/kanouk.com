#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseWxrString } from "emdash";
import { buildProductMap, convertPostContent } from "./yohaku-transformers.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Specify --output");
const sources = args.filter((value, index) => index !== outputIndex && index !== outputIndex + 1);
if (sources.length === 0) throw new Error("Specify at least one site-id=/path/export.xml source");

const totals = { posts: 0, pages: 0, attachments: 0, convertedBlocks: 0, htmlBlocks: 0 };
const reports = [];
for (const source of sources) {
	const separator = source.indexOf("=");
	if (separator < 1) throw new Error(`Invalid source: ${source}`);
	const siteId = source.slice(0, separator);
	const sourcePath = path.resolve(source.slice(separator + 1));
	const bytes = await fs.readFile(sourcePath);
	const wxr = await parseWxrString(bytes.toString("utf8"));
	const reusableBlocks = new Map(
		wxr.posts.filter((post) => post.postType === "wp_block").map((post) => [String(post.id), post]),
	);
	const products = buildProductMap(wxr.posts);
	const blockTypes = new Map();
	const fallbacks = new Map();
	const statuses = new Map();
	const publicContent = wxr.posts.filter((post) => ["post", "page"].includes(post.postType || ""));
	for (const post of publicContent) {
		statuses.set(post.status || "unknown", (statuses.get(post.status || "unknown") || 0) + 1);
		const converted = convertPostContent(post, { siteId, reusableBlocks, products });
		for (const block of converted) {
			blockTypes.set(block._type, (blockTypes.get(block._type) || 0) + 1);
			if (block._type === "htmlBlock") {
				const sourceType = block.originalBlockName || "freeform-html";
				fallbacks.set(sourceType, (fallbacks.get(sourceType) || 0) + 1);
			}
		}
		totals.convertedBlocks += converted.length;
	}
	const posts = publicContent.filter((post) => post.postType === "post").length;
	const pages = publicContent.filter((post) => post.postType === "page").length;
	totals.posts += posts;
	totals.pages += pages;
	totals.attachments += wxr.attachments.length;
	const htmlBlocks = fallbacks.values().reduce((sum, count) => sum + count, 0);
	totals.htmlBlocks += htmlBlocks;
	reports.push({
		siteId,
		source: {
			filename: path.basename(sourcePath),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
		},
		counts: { posts, pages, attachments: wxr.attachments.length, reusableBlocks: reusableBlocks.size, products: products.size },
		statuses: Object.fromEntries([...statuses].sort()),
		portableTextTypes: Object.fromEntries([...blockTypes].sort((a, b) => b[1] - a[1])),
		htmlBlockExceptions: Object.fromEntries([...fallbacks].sort((a, b) => b[1] - a[1])),
	});
}

const result = {
	reportVersion: 1,
	generatedAt: new Date().toISOString(),
	namespace: "yohaku.*",
	policy: "Known theme/plugin expressions use semantic blocks; remaining htmlBlock values require review.",
	totals,
	sites: reports,
};
await fs.mkdir(path.dirname(path.resolve(args[outputIndex + 1])), { recursive: true });
await fs.writeFile(path.resolve(args[outputIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(totals));
