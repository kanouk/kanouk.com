import { decodeSlug } from "emdash";

/**
 * WordPress imports can contain either decoded Unicode slugs or the original
 * percent-encoded post_name. Try the canonical decoded form first, then the
 * stored legacy form so old URLs keep resolving during migration.
 */
export function routeSlugCandidates(raw: string | undefined): string[] {
	const decoded = decodeSlug(raw);
	return [...new Set([decoded, raw].filter((value): value is string => Boolean(value)))];
}
