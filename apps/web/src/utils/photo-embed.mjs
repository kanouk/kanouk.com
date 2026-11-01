// HTML to show a public photo on another site: a resized image linking to its page.
// The resized image carries no location, unlike the original file.
const SIZES = [
	{ label: "小", width: 480 },
	{ label: "中", width: 768 },
	{ label: "大", width: 1200 },
	{ label: "特大", width: 1600 },
];

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function embedStorageKey(image) {
	const key = image?.meta?.storageKey;
	if (typeof key === "string" && key) return key;
	const match = String(image?.src ?? image?.url ?? "").match(/^\/_emdash\/api\/media\/file\/([^/?#]+)$/);
	if (!match) return undefined;
	try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

/** Sizes the photo can fill; a photo smaller than all of them still gets the smallest. */
export function embedSizes(photoWidth) {
	const fitting = SIZES.filter((size) => !photoWidth || size.width <= photoWidth);
	return fitting.length ? fitting : SIZES.slice(0, 1);
}

export function embedCode({ origin, path, storageKey, size, photoWidth, photoHeight, alt }) {
	const src = `${origin}/_yohaku/media/preview-v2/${size}/webp/${encodeURIComponent(storageKey)}`;
	const width = photoWidth ? Math.min(size, photoWidth) : size;
	const height = photoWidth && photoHeight ? ` height="${Math.round(photoHeight * width / photoWidth)}"` : "";
	return `<a href="${escapeHtml(origin + path)}"><img src="${escapeHtml(src)}" width="${width}"${height} alt="${escapeHtml(alt ?? "")}" loading="lazy" style="max-width:100%;height:auto"></a>`;
}
