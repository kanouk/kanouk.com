import { parseXPostUrl } from "../../plugins/yohaku-content-blocks/src/x-post-url.mjs";

/**
 * A bare X post URL on a line of its own becomes the post itself, as WordPress
 * did on paste; any other bare URL on its own line becomes a link card. The
 * stored content is untouched: this runs at render time and emits the same
 * `embed` / `yohaku.linkCard` nodes authored content carries, so one renderer
 * serves both.
 */

const textOf = (child) => (child && child._type === "span" && typeof child.text === "string" ? child.text : "");
const isBlank = (children) => children.every((child) => child?._type === "span" && textOf(child).trim() === "");

function linkHref(block, child) {
	if (child?._type !== "span" || !Array.isArray(child.marks) || child.marks.length !== 1) return null;
	const def = (block.markDefs ?? []).find((mark) => mark?._key === child.marks[0]);
	return def?._type === "link" && typeof def.href === "string" ? def.href : null;
}

/** The URL a span's visible text spells out, compared as parsed URLs so "/" and percent-encoding don't matter. */
function sameUrl(text, href) {
	try {
		const shown = new URL(text.trim());
		const target = new URL(href);
		return ["http:", "https:"].includes(target.protocol) && shown.href === target.href;
	} catch {
		return false;
	}
}

/** Index of the first child that is a promotable URL alone on its line, or -1. */
function findStandaloneLink(block, promote) {
	const children = block.children;
	for (let index = 0; index < children.length; index += 1) {
		const href = linkHref(block, children[index]);
		// The visible text must be the URL itself: a worded link stays a link.
		if (!href || !promote(href, textOf(children[index]))) continue;
		const before = children.slice(0, index).map(textOf).join("");
		const after = children.slice(index + 1).map(textOf).join("");
		const inline = (child) => child?._type !== "span";
		if (children.slice(0, index).some(inline) && !/\n[ \t]*$/.test(before)) continue;
		if (children.slice(index + 1).some(inline) && !/^[ \t]*\n/.test(after)) continue;
		if ((before.trim() === "" || /\n[ \t]*$/.test(before)) && (after.trim() === "" || /^[ \t]*\n/.test(after))) return index;
	}
	return -1;
}

function trimEdge(children, edge) {
	const result = children.map((child) => ({ ...child }));
	const at = edge === "end" ? result.length - 1 : 0;
	const child = result[at];
	if (child?._type === "span" && typeof child.text === "string") {
		child.text = edge === "end" ? child.text.replace(/\s+$/, "") : child.text.replace(/^\s+/, "");
	}
	return result;
}

function splitBlock(block, rule) {
	const index = findStandaloneLink(block, rule.promote);
	if (index < 0) return [block];
	const href = linkHref(block, block.children[index]);
	const before = trimEdge(block.children.slice(0, index), "end");
	const after = trimEdge(block.children.slice(index + 1), "start");
	const parts = [];
	if (before.length && !isBlank(before)) parts.push({ ...block, children: before });
	parts.push(rule.node(href, `${block._key ?? "x"}`, index));
	if (after.length && !isBlank(after)) parts.push(...splitBlock({ ...block, _key: `${block._key ?? "x"}:a${index}`, children: after }, rule));
	return parts;
}

const isXPost = (href, text) => {
	const post = parseXPostUrl(href);
	return Boolean(post) && parseXPostUrl(text)?.id === post.id;
};
const xPostNode = (href, key, index) => ({ _type: "embed", _key: `${key}:x${index}`, url: href, provider: "twitter" });

const X_POSTS = { promote: isXPost, node: xPostNode };
/** X posts keep their embed; any other http(s) URL alone on its line becomes a link card. */
const STANDALONE_LINKS = {
	promote: (href, text) => isXPost(href, text) || sameUrl(text, href),
	node: (href, key, index) => parseXPostUrl(href)
		? xPostNode(href, key, index)
		: { _type: "yohaku.linkCard", _key: `${key}:c${index}`, id: href },
};

function promote(content, rule) {
	return (content ?? []).flatMap((block) => {
		const plain = block && block._type === "block" && !block.listItem && (block.style ?? "normal") === "normal" && Array.isArray(block.children);
		return plain ? splitBlock(block, rule) : [block];
	});
}

/**
 * @template T
 * @param {readonly T[] | null | undefined} content Portable Text blocks
 * @returns {T[]}
 */
export function promoteXPostLinks(content) {
	return promote(content, X_POSTS);
}

/**
 * A bare URL on a line of its own renders as an X post (for X URLs) or a link card
 * (anything else). Render-time only; stored content is untouched. The public link
 * preview endpoint runs the same promotion, so these cards can refresh their metadata
 * exactly like cards an author inserted.
 *
 * @template T
 * @param {readonly T[] | null | undefined} content Portable Text blocks
 * @returns {T[]}
 */
export function promoteStandaloneLinks(content) {
	return promote(content, STANDALONE_LINKS);
}
