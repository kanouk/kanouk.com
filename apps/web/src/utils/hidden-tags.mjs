/**
 * Tags the owner uses for housekeeping, not for readers. They stay on the
 * posts in the CMS but never appear on the public site: not in tag lists,
 * not on post cards, and their tag pages answer 404.
 */
const HIDDEN_TAG_LABELS = new Set(["一覧非表示"]);

function decoded(value) {
	try {
		return decodeURIComponent(String(value ?? ""));
	} catch {
		return String(value ?? "");
	}
}

/**
 * True for a term (or anything with a label / slug) that must stay off the public site.
 * @param {{ label?: string | null, slug?: string | null } | null | undefined} term
 * @returns {boolean}
 */
export function isHiddenTag(term) {
	if (!term) return false;
	return HIDDEN_TAG_LABELS.has(String(term.label ?? "").trim()) || HIDDEN_TAG_LABELS.has(decoded(term.slug).trim());
}

/**
 * The tags a reader may see, in their original order.
 * @template {{ label?: string | null, slug?: string | null }} T
 * @param {readonly T[] | null | undefined} tags
 * @returns {T[]}
 */
export function visibleTags(tags) {
	return (tags ?? []).filter((tag) => !isHiddenTag(tag));
}
