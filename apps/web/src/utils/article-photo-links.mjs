export const ARTICLE_PHOTO_LINKS_QUERY = `
	SELECT photo.id, json_extract(live.data, '$.image.id') AS media_id
	FROM ec_photos AS photo
	JOIN revisions AS live ON live.id = photo.live_revision_id
	JOIN ec_albums AS album ON album.id = json_extract(live.data, '$.album')
	WHERE photo.status = 'published' AND photo.deleted_at IS NULL
		AND album.status = 'published' AND album.deleted_at IS NULL
		AND json_extract(live.data, '$.image.id') IN (SELECT value FROM json_each(?1))
`;

import { digestKey, edgeMemo } from "./edge-memo.mjs";

export async function articlePhotoLinks(database, content) {
	const mediaIds = [...new Set((content ?? []).filter(block => block?._type === "image")
		.map(block => block.asset?._ref).filter(id => typeof id === "string" && id.length > 0))];
	if (mediaIds.length === 0) return new Map();
	const idList = JSON.stringify([...mediaIds].sort());
	// The query scans every published photo; a few minutes of staleness only
	// delays a new photo link, so the rows are shared across renders.
	const results = await edgeMemo(`article-photo-links:${await digestKey(idList)}`, 300, async () =>
		(await database.prepare(ARTICLE_PHOTO_LINKS_QUERY).bind(idList).all()).results, { scope: database });
	const candidates = new Map();
	for (const row of results) {
		if (typeof row.media_id !== "string" || typeof row.id !== "string") continue;
		const ids = candidates.get(row.media_id) ?? new Set();
		ids.add(row.id);
		candidates.set(row.media_id, ids);
	}
	return new Map([...candidates].filter(([, ids]) => ids.size === 1).map(([id, ids]) => [id, [...ids][0]]));
}
