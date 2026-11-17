import { parseXPostUrl } from "../../plugins/yohaku-content-blocks/src/x-post-url.mjs";

/**
 * A bare X post URL on a line of its own becomes the post itself, as WordPress
 * did on paste. The stored content is untouched: this runs at render time and
 * emits the same `embed` node the migrated posts carry, so one renderer serves both.
 */

const textOf = (child) => (child && child._type === "span" && typeof child.text === "string" ? child.text : "");
const isBlank = (children) => children.every((child) => child?._type === "span" && textOf(child).trim() === "");

function linkHref(block, child) {
	if (child?._type !== "span" || !Array.isArray(child.marks) || child.marks.length !== 1) return null;
	const def = (block.markDefs ?? []).find((mark) => mark?._key === child.marks[0]);
	return def?._type === "link" && typeof def.href === "string" ? def.href : null;
}

/** Index of the first child that is an X post URL alone on its line, or -1. */
function findPostLink(block) {
	const children = block.children;
	for (let index = 0; index < children.length; index += 1) {
		const href = linkHref(block, children[index]);
		const post = href ? parseXPostUrl(href) : null;
		// The visible text must be the URL itself: a worded link stays a link.
		if (!post || parseXPostUrl(textOf(children[index]))?.id !== post.id) continue;
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

function splitBlock(block) {
	const index = findPostLink(block);
	if (index < 0) return [block];
	const href = linkHref(block, block.children[index]);
	const before = trimEdge(block.children.slice(0, index), "end");
	const after = trimEdge(block.children.slice(index + 1), "start");
	const parts = [];
	if (before.length && !isBlank(before)) parts.push({ ...block, children: before });
	parts.push({ _type: "embed", _key: `${block._key ?? "x"}:x${index}`, url: href, provider: "twitter" });
	if (after.length && !isBlank(after)) parts.push(...splitBlock({ ...block, _key: `${block._key ?? "x"}:a${index}`, children: after }));
	return parts;
}

/**
 * @template T
 * @param {readonly T[] | null | undefined} content Portable Text blocks
 * @returns {T[]}
 */
export function promoteXPostLinks(content) {
	return (content ?? []).flatMap((block) => {
		const plain = block && block._type === "block" && !block.listItem && (block.style ?? "normal") === "normal" && Array.isArray(block.children);
		return plain ? splitBlock(block) : [block];
	});
}
