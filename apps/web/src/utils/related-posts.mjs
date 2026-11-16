import { visibleTags } from "./hidden-tags.mjs";

/** Posts shown under 「続けて読む」. */
export const RELATED_POST_LIMIT = 3;

/**
 * Rows each candidate query should fetch. Every tier is asked for the same
 * top-N, so the current post plus whatever earlier tiers already picked can
 * never crowd out the posts this tier still has to supply: if k posts are
 * already picked, at most 1 + k of the first `limit + 1` rows are excluded,
 * leaving at least `limit - k` new ones.
 */
export function relatedCandidateLimit(limit = RELATED_POST_LIMIT) {
	return limit + 1;
}

/** Slugs of the tags that may count as "shared" (hidden housekeeping tags never do). */
export function relatedTagSlugs(tags) {
	return termSlugs(visibleTags(tags));
}

/** Unique, non-empty slugs of taxonomy terms, in their original order. */
export function termSlugs(terms) {
	const slugs = [];
	for (const term of terms ?? []) {
		const slug = String(term?.slug ?? "").trim();
		if (slug && !slugs.includes(slug)) slugs.push(slug);
	}
	return slugs;
}

function entryKey(entry) {
	return String(entry?.data?.id ?? entry?.id ?? "");
}

function publishedTime(entry) {
	const value = entry?.data?.publishedAt;
	if (value == null) return Number.NEGATIVE_INFINITY;
	const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function isPublished(entry) {
	const status = entry?.data?.status;
	return status === undefined || status === null || status === "published";
}

/**
 * Pick the posts for 「続けて読む」 from candidate tiers in priority order
 * (shared tag, then same category, then newest). Never the current post, no
 * duplicates, only published posts, newest first within each tier.
 *
 * @template T
 * @param {{ current: { id?: string, data?: { id?: string } }, tiers: Array<ReadonlyArray<T> | undefined>, limit?: number }} options
 * @returns {T[]}
 */
export function pickRelatedPosts({ current, tiers, limit = RELATED_POST_LIMIT }) {
	const excluded = new Set([current?.data?.id, current?.id].filter(Boolean).map(String));
	const picked = [];
	for (const tier of tiers ?? []) {
		if (picked.length >= limit) break;
		const ordered = (tier ?? [])
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => publishedTime(b.entry) - publishedTime(a.entry) || a.index - b.index)
			.map(({ entry }) => entry);
		for (const entry of ordered) {
			if (picked.length >= limit) break;
			const key = entryKey(entry);
			if (!key || excluded.has(key) || (entry?.id && excluded.has(String(entry.id))) || !isPublished(entry)) continue;
			excluded.add(key);
			if (entry?.id) excluded.add(String(entry.id));
			picked.push(entry);
		}
	}
	return picked;
}
