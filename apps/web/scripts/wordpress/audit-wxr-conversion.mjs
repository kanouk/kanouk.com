#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildImportPlan, loadQuizMap } from "./import-wxr.mjs";
import { buildProductMap, convertPostContent } from "./yohaku-transformers.mjs";

const DEFAULT_QUIZ_PATH = path.resolve("../../migration/wordpress/quiz-maker.json");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Specify --output");
const outputPath = path.resolve(args[outputIndex + 1]);

const { loadedSources, records } = await buildImportPlan();
const quizzes = await loadQuizMap(DEFAULT_QUIZ_PATH);
const totals = {
	posts: 0,
	pages: 0,
	attachments: 0,
	convertedBlocks: 0,
	htmlBlocks: 0,
	imageBlocks: 0,
	imageDisplayWidths: 0,
	imageTreatments: {},
};
const reports = [];

for (const source of loadedSources) {
	const sourceRecords = records.filter((record) => record.source.id === source.id);
	const reusableBlocks = new Map(
		source.wxr.posts.filter((post) => post.postType === "wp_block").map((post) => [String(post.id), post]),
	);
	const products = buildProductMap(source.wxr.posts);
	const blockTypes = new Map();
	const fallbacks = new Map();
	const statuses = new Map();
	const imageTreatments = new Map();
	let imageDisplayWidths = 0;
	for (const record of sourceRecords) {
		const { post } = record;
		statuses.set(post.status || "unknown", (statuses.get(post.status || "unknown") || 0) + 1);
		const converted = convertPostContent(post, { siteId: source.id, reusableBlocks, products, quizzes });
		for (const block of converted) {
			blockTypes.set(block._type, (blockTypes.get(block._type) || 0) + 1);
			if (block._type === "image") {
				const treatment = block.visualStyle || "default";
				imageTreatments.set(treatment, (imageTreatments.get(treatment) || 0) + 1);
				if (typeof block.displayWidth === "number") imageDisplayWidths++;
			}
			if (block._type === "htmlBlock") {
				const sourceType = block.originalBlockName || "freeform-html";
				fallbacks.set(sourceType, (fallbacks.get(sourceType) || 0) + 1);
			}
		}
		totals.convertedBlocks += converted.length;
	}
	const posts = sourceRecords.filter((record) => record.post.postType === "post").length;
	const pages = sourceRecords.filter((record) => record.post.postType === "page").length;
	const htmlBlocks = [...fallbacks.values()].reduce((sum, count) => sum + count, 0);
	totals.posts += posts;
	totals.pages += pages;
	totals.attachments += source.wxr.attachments.length;
	totals.htmlBlocks += htmlBlocks;
	const imageBlocks = [...imageTreatments.values()].reduce((sum, count) => sum + count, 0);
	totals.imageBlocks += imageBlocks;
	totals.imageDisplayWidths += imageDisplayWidths;
	for (const [treatment, count] of imageTreatments) {
		totals.imageTreatments[treatment] = (totals.imageTreatments[treatment] || 0) + count;
	}
	reports.push({
		siteId: source.id,
		sources: [
			{
				kind: "wxr",
				filename: path.basename(source.file),
				sha256: createHash("sha256").update(source.xml).digest("hex"),
				bytes: Buffer.byteLength(source.xml),
			},
			...(source.restDelta ? [{
				kind: "rest-delta",
				filename: path.basename(source.restDelta.path),
				sha256: source.restDelta.sha256,
			}] : []),
		],
		counts: {
			posts,
			pages,
			attachments: source.wxr.attachments.length,
			reusableBlocks: reusableBlocks.size,
			products: products.size,
		},
		statuses: Object.fromEntries([...statuses].sort()),
		portableTextTypes: Object.fromEntries([...blockTypes].sort((a, b) => b[1] - a[1])),
		imagePresentation: {
			blocks: imageBlocks,
			displayWidths: imageDisplayWidths,
			treatments: Object.fromEntries([...imageTreatments].sort((a, b) => b[1] - a[1])),
		},
		htmlBlockExceptions: Object.fromEntries([...fallbacks].sort((a, b) => b[1] - a[1])),
	});
}

const result = {
	reportVersion: 2,
	generatedAt: new Date().toISOString(),
	namespace: "yohaku.*",
	policy: "Known theme/plugin expressions use semantic blocks; remaining htmlBlock values require review.",
	quizSource: { filename: path.basename(DEFAULT_QUIZ_PATH), quizzes: quizzes.size },
	totals,
	sites: reports,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(totals));
