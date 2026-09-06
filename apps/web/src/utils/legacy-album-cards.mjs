const SMUGMUG_CLOSING = /^(?:(?:その他|そのほか)の)?写真はsmugmug(?:で|へ)[。.]?(?:\(あまり残ってなかった\))?$/i;

/** @typedef {{kind: "current", key: string} | {kind: "legacy", href: string}} AlbumLinkReference */

function blockText(block) {
	if (block?._type !== "block" || !Array.isArray(block.children)) return "";
	return block.children
		.map((child) => typeof child?.text === "string" ? child.text : "")
		.join("");
}

export function isExplicitSmugMugClosing(block) {
	const text = blockText(block).normalize("NFKC").replace(/\s+/g, "");
	return SMUGMUG_CLOSING.test(text);
}

export function legacyAlbumLinkHref(block) {
	if (block?._type !== "yohaku.linkCard") return "";
	const candidate = typeof block.id === "string" ? block.id : block.url;
	return typeof candidate === "string" ? candidate.trim() : "";
}

export function inlineLegacyAlbumLinkHref(block) {
	if (!isExplicitSmugMugClosing(block) || !Array.isArray(block.markDefs)) return "";
	const links = block.markDefs.filter((definition) =>
		definition?._type === "link" &&
		typeof definition._key === "string" &&
		typeof definition.href === "string" &&
		classifyAlbumLink(definition.href)
	);
	if (links.length !== 1) return "";
	const linkedText = block.children
		.filter((child) => Array.isArray(child?.marks) && child.marks.includes(links[0]._key))
		.map((child) => typeof child.text === "string" ? child.text : "")
		.join("")
		.normalize("NFKC")
		.replace(/\s+/g, "")
		.toLowerCase();
	return linkedText === "smugmug" ? links[0].href.trim() : "";
}

/** @returns {AlbumLinkReference | null} */
export function classifyAlbumLink(href) {
	let parsed;
	try {
		parsed = new URL(href);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname.replace(/\/+$/, "");
	if (host === "photos.kanouk.com") {
		const key = path.match(/^\/albums\/([^/]+)$/)?.[1];
		if (!key) return null;
		try {
			return { kind: "current", key: decodeURIComponent(key) };
		} catch {
			return null;
		}
	}
	if (host === "kanolog.smugmug.com" && !/\/i-[A-Za-z0-9]+(?:\/|$)/.test(path)) {
		return path.match(/^\/[^/]+$/) ? { kind: "legacy", href: parsed.href } : null;
	}
	return null;
}

export function comparableAlbumHref(href) {
	try {
		const parsed = new URL(href);
		return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
	} catch {
		return "";
	}
}

export function legacySourceUrlVariants(href) {
	try {
		const parsed = new URL(href);
		parsed.search = "";
		parsed.hash = "";
		const withoutSlash = parsed.href.replace(/\/+$/, "");
		return [...new Set([withoutSlash, `${withoutSlash}/`])];
	} catch {
		return [];
	}
}

/**
 * @param {unknown[]} blocks
 * @param {(reference: AlbumLinkReference, href: string) => string | Promise<string>} resolveAlbumId
 */
export async function normalizeLegacyAlbumCards(blocks, resolveAlbumId) {
	if (!Array.isArray(blocks)) return { content: [], converted: 0 };
	const content = [];
	let converted = 0;
	for (let index = 0; index < blocks.length; index++) {
		const intro = blocks[index];
		const inlineHref = inlineLegacyAlbumLinkHref(intro);
		const inlineReference = inlineHref ? classifyAlbumLink(inlineHref) : null;
		const inlineAlbumId = inlineReference ? await resolveAlbumId(inlineReference, inlineHref) : "";
		if (typeof inlineAlbumId === "string" && inlineAlbumId) {
			content.push({ _type: "yohaku.album", _key: intro._key, id: inlineAlbumId });
			converted++;
			continue;
		}
		const linkCard = blocks[index + 1];
		const href = isExplicitSmugMugClosing(intro) ? legacyAlbumLinkHref(linkCard) : "";
		const reference = href ? classifyAlbumLink(href) : null;
		const albumId = reference ? await resolveAlbumId(reference, href) : "";
		if (typeof albumId === "string" && albumId) {
			content.push({ _type: "yohaku.album", _key: linkCard._key, id: albumId });
			converted++;
			index++;
			continue;
		}
		content.push(intro);
	}
	return { content, converted };
}
