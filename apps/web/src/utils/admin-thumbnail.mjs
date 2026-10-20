const MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";
const WIDTHS = [320, 480, 768, 1200, 1600];

/**
 * EmDash's media library asks Astro's `/_image?href=<origin>/_emdash/api/media/file/<key>&w=400&f=webp`
 * for its thumbnails. This site does not run Astro's image service (it resizes
 * with its own preview route), so that endpoint answered 404 and the admin fell
 * back to multi-MB originals. Map such a request onto the preview route instead.
 *
 * Returns `{ key, width, format }` for a same-origin stored-media request, or null.
 * @param {URL} url the `/_image` request URL
 * @returns {{ encodedKey: string, width: number, format: "avif" | "webp" } | null}
 */
export function adminThumbnailRequest(url) {
	if (url.pathname !== "/_image") return null;
	let source;
	try { source = new URL(url.searchParams.get("href") ?? "", url); } catch { return null; }
	if (source.origin !== url.origin || !source.pathname.startsWith(MEDIA_FILE_PREFIX)) return null;
	const encodedKey = source.pathname.slice(MEDIA_FILE_PREFIX.length);
	if (!encodedKey || encodedKey.includes("/")) return null;
	const requested = Number(url.searchParams.get("w"));
	const width = WIDTHS.find((candidate) => candidate >= (Number.isFinite(requested) && requested > 0 ? requested : 400)) ?? 1600;
	const format = url.searchParams.get("f") === "avif" ? "avif" : "webp";
	return { encodedKey, width, format };
}
