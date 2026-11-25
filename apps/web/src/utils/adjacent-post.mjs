// The article pager needs only which post is next to this one. Asking EmDash
// for a one-row collection reads ~190 rows in D1 (it widens the limit and joins
// terms and bylines for every row it fetched); this reads one index row, and
// the page then loads just that entry. Same filter and order as the collection
// query it replaces: published, not trashed, strictly older/newer, ties by id.
export const OLDER_POST_QUERY = `
	SELECT id FROM ec_posts
	WHERE deleted_at IS NULL AND status = 'published' AND published_at < ?1
	ORDER BY published_at DESC, id DESC
	LIMIT 1
`;
export const NEWER_POST_QUERY = `
	SELECT id FROM ec_posts
	WHERE deleted_at IS NULL AND status = 'published' AND published_at > ?1
	ORDER BY published_at ASC, id ASC
	LIMIT 1
`;

/**
 * @param {{ prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } } }} database
 * @param {string} publishedAt ISO timestamp of the current post
 * @param {"older" | "newer"} direction
 * @returns {Promise<string | undefined>}
 */
export async function adjacentPostId(database, publishedAt, direction) {
	const row = await database
		.prepare(direction === "older" ? OLDER_POST_QUERY : NEWER_POST_QUERY)
		.bind(publishedAt)
		.first();
	return typeof row?.id === "string" && row.id ? row.id : undefined;
}
