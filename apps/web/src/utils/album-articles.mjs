import {
	comparableAlbumHref,
	normalizeLegacyAlbumCards,
} from "./legacy-album-cards.mjs";

// SQL narrows the scan to published posts containing the article-level
// reference, the exact native album block, or a link target for this published
// album. The shared JS normalizer then applies the stricter adjacency, copy,
// and inline-mark rules to legacy links.
export const ALBUM_ARTICLES_QUERY = `
	WITH target_base AS (
		SELECT album.id, album.slug, json_extract(album_live.data, '$.source_url') AS source_url
		FROM ec_albums AS album
		JOIN revisions AS album_live ON album_live.id = album.live_revision_id
		WHERE album.id = ?1 AND album.status = 'published' AND album.deleted_at IS NULL
	), target_album AS (
		SELECT target_base.*,
			(SELECT count(*)
			 FROM ec_albums AS candidate
			 JOIN revisions AS candidate_live ON candidate_live.id = candidate.live_revision_id
			 WHERE candidate.status = 'published' AND candidate.deleted_at IS NULL
				AND rtrim(json_extract(candidate_live.data, '$.source_url'), '/') = rtrim(target_base.source_url, '/')
			) AS source_url_matches
		FROM target_base
	)
	SELECT
		post.id,
		json_extract(live.data, '$.title') AS title,
		json_extract(live.data, '$.content') AS content,
		json_extract(live.data, '$.related_album') AS related_album_id,
		target_album.slug AS album_slug,
		target_album.source_url AS album_source_url,
		target_album.source_url_matches
	FROM ec_posts AS post
	JOIN revisions AS live ON live.id = post.live_revision_id
	CROSS JOIN target_album
	WHERE post.status = 'published' AND post.deleted_at IS NULL
		AND post.locale = ?2
		AND (
			json_extract(live.data, '$.related_album') = ?1
			OR
			EXISTS (
				SELECT 1 FROM json_each(live.data, '$.content') AS block
				WHERE json_extract(block.value, '$._type') = 'yohaku.album'
					AND json_extract(block.value, '$.id') = ?1
			)
			OR EXISTS (
				SELECT 1 FROM json_tree(live.data, '$.content') AS reference
				WHERE reference.key IN ('id', 'url', 'href')
					AND reference.atom IN (
						target_album.source_url,
						rtrim(target_album.source_url, '/') || '/',
						'https://photos.kanouk.com/albums/' || target_album.slug,
						'https://photos.kanouk.com/albums/' || target_album.slug || '/',
						'https://photos.kanouk.com/albums/' || target_album.id,
						'https://photos.kanouk.com/albums/' || target_album.id || '/'
					)
			)
		)
	ORDER BY post.published_at DESC, post.id ASC
	LIMIT 100
`;

function parsedContent(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** @returns {Promise<Array<{id: string, title: string}>>} */
export async function relatedAlbumArticles(database, albumId, locale = "ja") {
	const { results } = await database.prepare(ALBUM_ARTICLES_QUERY).bind(albumId, locale).all();
	const related = [];
	for (const row of results) {
		if (typeof row.id !== "string" || typeof row.title !== "string" || !row.title.trim()) continue;
		const content = parsedContent(row.content);
		const configured = row.related_album_id === albumId;
		const explicit = content.some((block) => block?._type === "yohaku.album" && block.id === albumId);
		let legacy = false;
		if (!configured && !explicit) {
			const sourceKey = comparableAlbumHref(row.album_source_url);
			const normalized = await normalizeLegacyAlbumCards(content, async (reference, href) => {
				if (reference.kind === "current") {
					return reference.key === row.album_slug || reference.key === albumId ? albumId : "";
				}
				return row.source_url_matches === 1 && comparableAlbumHref(href) === sourceKey ? albumId : "";
			});
			legacy = normalized.converted > 0;
		}
		if (configured || explicit || legacy) related.push({ id: row.id, title: row.title });
		if (related.length === 20) break;
	}
	return related;
}
