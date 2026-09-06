// Only an explicit album block in the published revision establishes a relation.
// Draft edits, inline photo selections, and incidental text URLs do not.
export const ALBUM_ARTICLES_QUERY = `
	SELECT post.id, json_extract(live.data, '$.title') AS title
	FROM ec_posts AS post
	JOIN revisions AS live ON live.id = post.live_revision_id
	WHERE post.status = 'published' AND post.deleted_at IS NULL
		AND post.locale = ?2
		AND EXISTS (
			SELECT 1 FROM json_each(live.data, '$.content') AS block
			WHERE json_extract(block.value, '$._type') = 'yohaku.album'
				AND json_extract(block.value, '$.id') = ?1
		)
	ORDER BY post.published_at DESC, post.id ASC
	LIMIT 20
`;

/** @returns {Promise<Array<{id: string, title: string}>>} */
export async function relatedAlbumArticles(database, albumId, locale = "ja") {
	const { results } = await database.prepare(ALBUM_ARTICLES_QUERY).bind(albumId, locale).all();
	return results.filter(row => typeof row.id === "string" && typeof row.title === "string" && row.title.trim())
		.map(row => ({ id: row.id, title: row.title }));
}
