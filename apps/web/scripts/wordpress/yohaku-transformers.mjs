import { createHash } from "node:crypto";
import {
	extractText,
	gutenbergToPortableText,
	htmlToPortableText,
} from "@emdash-cms/gutenberg-to-portable-text";

function safeText(html = "") {
	return extractText(html).trim();
}

function matchClassText(html, className) {
	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = html.match(new RegExp(`<[^>]+class=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`));
	return match ? safeText(match[1]) : "";
}

function productNode(product, sourceId, key) {
	return {
		_type: "yohaku.productCard",
		_key: key,
		title: product?.title || "商品情報",
		imageUrl: product?.imageUrl || undefined,
		id: product?.primaryUrl || undefined,
		label: "商品を見る",
		links: product?.links || [],
		sourceProductId: String(sourceId || ""),
	};
}

function expandPochippShortcodes(blocks, context, keyGenerator) {
	return blocks.flatMap((block) => {
		if (block?._type !== "block" || !Array.isArray(block.children)) return block;
		if (!block.children.some((child) =>
			child?._type === "span"
			&& typeof child.text === "string"
			&& /\[pochipp\s+id=["']?\d+["']?\s*\]/i.test(child.text),
		)) return block;
		const expanded = [];
		let pending = { ...block, children: [] };
		const flush = () => {
			const meaningful = pending.children.some((child) =>
				child?._type !== "span" || String(child.text || "").trim(),
			);
			if (meaningful) expanded.push(pending);
			pending = { ...block, _key: keyGenerator(), children: [] };
		};
		for (const child of block.children) {
			if (child?._type !== "span" || typeof child.text !== "string") {
				pending.children.push(child);
				continue;
			}
			const matches = [...child.text.matchAll(/\[pochipp\s+id=["']?(\d+)["']?\s*\]/gi)];
			if (!matches.length) {
				pending.children.push(child);
				continue;
			}
			let cursor = 0;
			for (const match of matches) {
				const before = child.text.slice(cursor, match.index);
				if (before) pending.children.push({ ...child, _key: keyGenerator(), text: before });
				flush();
				const sourceId = match[1];
				expanded.push(productNode(context.products.get(sourceId), sourceId, keyGenerator()));
				cursor = match.index + match[0].length;
			}
			const after = child.text.slice(cursor);
			if (after) pending.children.push({ ...child, _key: keyGenerator(), text: after });
		}
		flush();
		return expanded.length ? expanded : block;
	});
}

function tableNode(html, keyGenerator) {
	const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => ({
		_type: "tableRow",
		_key: keyGenerator(),
		cells: [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) => ({
			_type: "tableCell",
			_key: keyGenerator(),
			isHeader: cell[1].toLowerCase() === "th",
			content: [{ _type: "span", _key: keyGenerator(), text: safeText(cell[2]) }],
		})),
	}));
	return {
		_type: "table",
		_key: keyGenerator(),
		rows,
		hasHeaderRow: rows[0]?.cells.every((cell) => cell.isHeader) || false,
	};
}

export function createDeterministicKeyGenerator(namespace) {
	let index = 0;
	return () =>
		createHash("sha256")
			.update(`${namespace}:${index++}`)
			.digest("hex")
			.slice(0, 16);
}

export function buildProductMap(posts) {
	const result = new Map();
	for (const post of posts) {
		if (post.postType !== "pochipps") continue;
		const meta = post.meta;
		const links = [
			["Amazon", meta.get("yyi_rinker_amazon_title_url") || meta.get("yyi_rinker_amazon_url")],
			["楽天市場", meta.get("yyi_rinker_rakuten_url")],
			["Yahoo!ショッピング", meta.get("yyi_rinker_yahoo_url")],
		]
			.filter((entry) => entry[1])
			.map(([label, url]) => ({ label, url }));
		result.set(String(post.id), {
			title: post.title || "商品情報",
			imageUrl:
				meta.get("yyi_rinker_l_image_url") ||
				meta.get("yyi_rinker_m_image_url") ||
				meta.get("yyi_rinker_s_image_url") ||
				undefined,
			primaryUrl: links[0]?.url,
			links,
		});
	}
	return result;
}

export function convertPostContent(post, context) {
	const keyGenerator = createDeterministicKeyGenerator(`${context.siteId}:${post.id}`);
	let customTransformers;
	const options = () => ({ customTransformers, keyGenerator, generateKeys: true });
	customTransformers = {
		"core/block": (block) => {
			const reusable = context.reusableBlocks.get(String(block.attrs.ref || ""));
			return reusable ? gutenbergToPortableText(reusable.content || "", options()) : [];
		},
		"loos-hcb/code-block": (block, _options, tools) => {
			const code = block.innerHTML.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] || "";
			return [{
				_type: "code",
				_key: tools.generateKey(),
				code: safeText(code),
				language: String(block.attrs.langType || block.attrs.langName || "text").toLowerCase(),
			}];
		},
		"loos/balloon": (block, _options, tools) => [{
			_type: "yohaku.dialogue",
			_key: tools.generateKey(),
			body: safeText(block.innerHTML),
			sourceSpeakerId: String(block.attrs.balloonID || ""),
		}],
		"loos/post-link": (block, _options, tools) => [{
			_type: "yohaku.linkCard",
			_key: tools.generateKey(),
			id: block.attrs.postId
				? `wordpress://${context.siteId}/post/${block.attrs.postId}`
				: undefined,
			title: String(block.attrs.postTitle || "関連記事"),
		}],
		"jin-gb-block/blog-card": (block, _options, tools) => [{
			_type: "yohaku.linkCard",
			_key: tools.generateKey(),
			id: String(block.attrs.url || safeText(block.innerHTML) || ""),
		}],
		"jin-gb-block/border": (_block, _options, tools) => [{
			_type: "break",
			_key: tools.generateKey(),
			style: "lineBreak",
		}],
		"jin-gb-block/icon-box": (block, _options, tools) => [{
			_type: "yohaku.callout",
			_key: tools.generateKey(),
			tone: "tip",
			content: tools.transformBlocks(block.innerBlocks),
		}],
		"jin-gb-block/box-with-headline": (block, _options, tools) => [{
			_type: "yohaku.callout",
			_key: tools.generateKey(),
			title: String(block.attrs.boxTitle || ""),
			tone: "note",
			content: tools.transformBlocks(block.innerBlocks),
		}],
		"loos/cap-block": (block, _options, tools) => [{
			_type: "yohaku.callout",
			_key: tools.generateKey(),
			title: matchClassText(block.innerHTML, "cap_box_ttl"),
			tone: "note",
			content: tools.transformBlocks(block.innerBlocks),
		}],
		"jetpack/rating-star": (block, _options, tools) => [{
			_type: "yohaku.rating",
			_key: tools.generateKey(),
			score: Number(block.attrs.rating || 0),
			max: 5,
		}],
		"wpmf/wordpress-gallery": (block, _options, tools) => [{
			_type: "gallery",
			_key: tools.generateKey(),
			columns: 3,
			images: Array.isArray(block.attrs.images)
				? block.attrs.images.map((image) => ({
						_type: "image",
						_key: tools.generateKey(),
						asset: { _type: "reference", _ref: String(image.id || image.url), url: image.url },
						alt: image.title || "",
						caption: image.caption || "",
					}))
				: [],
		}],
		"pochipp/linkbox": (block, _options, tools) => [
			productNode(context.products.get(String(block.attrs.pid || "")), block.attrs.pid, tools.generateKey()),
		],
		"rinkerg/gutenberg-rinker": (block, _options, tools) => {
			const sourceId = String(block.attrs.post_id || block.attrs.content_text?.match(/post_id=["']?(\d+)/)?.[1] || "");
			return [productNode(context.products.get(sourceId), sourceId, tools.generateKey())];
		},
		"loos/step": (block, _options, tools) => [{
			_type: "yohaku.steps",
			_key: tools.generateKey(),
			items: block.innerBlocks
				.filter((item) => item.blockName === "loos/step-item")
				.map((item, index) => ({
					_key: tools.generateKey(),
					title: matchClassText(item.innerHTML, "swell-block-step__title") || `Step ${index + 1}`,
					content: tools.transformBlocks(item.innerBlocks),
				})),
		}],
		"loos/step-item": (block, _options, tools) => tools.transformBlocks(block.innerBlocks),
		"loos/accordion": (block, _options, tools) => block.innerBlocks.map((item) => ({
			_type: "yohaku.accordion",
			_key: tools.generateKey(),
			title: matchClassText(item.innerHTML, "swell-block-accordion__label") || "詳細",
			content: tools.transformBlocks(item.innerBlocks),
		})),
		"loos/accordion-item": (block, _options, tools) => [{
			_type: "yohaku.accordion",
			_key: tools.generateKey(),
			title: matchClassText(block.innerHTML, "swell-block-accordion__label") || "詳細",
			content: tools.transformBlocks(block.innerBlocks),
		}],
	};

	const blocks = gutenbergToPortableText(post.content || "", options());
	const normalized = blocks.flatMap((block) => {
		if (block._type !== "htmlBlock") return block;
		const html = String(block.html || "");
		const quizId = html.match(/\[ays_quiz\s+id=["']?(\d+)["']?\s*\]/i)?.[1];
		if (quizId) {
			const quiz = context.quizzes?.get?.(quizId) || context.quizzes?.[quizId];
			if (!quiz) return block;
			return {
				_type: "yohaku.quiz",
				_key: block._key,
				title: quiz.title || "クイズ",
				description: quiz.description || undefined,
				questions: quiz.questions || [],
				sourceQuizId: quizId,
			};
		}
		if (/(?:class|id)=["'][^"']*search-container\b/i.test(html)) {
			return {
				_type: "yohaku.siteSearch",
				_key: block._key,
				label: "ブログ内を検索",
				placeholder: "検索語を入力",
			};
		}
		const sourceId = String(block.html || "").match(/\[itemlink\s+post_id=["']?(\d+)/i)?.[1];
		if (sourceId) return productNode(context.products.get(sourceId), sourceId, block._key);
		if (/<table\b/i.test(html)) return tableNode(html, keyGenerator);
		const iframeSource = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
		if (iframeSource) {
			return { _type: "embed", _key: block._key, url: iframeSource, provider: "google-maps" };
		}
		if (/entry-subtitle/.test(html)) {
			return {
				_type: "block",
				_key: block._key,
				style: "h3",
				children: [{ _type: "span", _key: keyGenerator(), text: safeText(html) }],
				markDefs: [],
			};
		}
		if (!block.originalBlockName) {
			return htmlToPortableText(html, options());
		}
		return block;
	});
	return expandPochippShortcodes(normalized, context, keyGenerator);
}
