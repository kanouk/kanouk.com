import { buildBlogPostingJsonLd, resolvePageMetadata } from "emdash/page";

/**
 * EmDash 1.4 overlays stored SEO after the layout builds its page context.
 * Keep migrated post URLs consistent with the stable-ID public routes.
 *
 * @param {Parameters<typeof buildBlogPostingJsonLd>[0]} page
 * @returns {Parameters<typeof resolvePageMetadata>[0] | null}
 */
export function postCanonicalMetadata(page) {
	if (page.content?.collection !== "posts" || page.pageType !== "article") return null;
	const id = page.content.id;
	if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
	const canonical = `https://blog.kanouk.com/posts/${id}`;
	const graph = buildBlogPostingJsonLd({ ...page, canonical });
	return [
		{ kind: "link", rel: "canonical", href: canonical },
		{ kind: "property", property: "og:url", content: canonical },
		...(graph ? [{ kind: /** @type {const} */ ("jsonld"), id: "primary", graph }] : []),
	];
}
