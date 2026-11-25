export const ARTICLE_PHOTO_LINKS_QUERY = `
	SELECT photo.id, json_extract(live.data, '$.image.id') AS media_id
	FROM ec_photos AS photo
	JOIN revisions AS live ON live.id = photo.live_revision_id
	JOIN ec_albums AS album ON album.id = json_extract(live.data, '$.album')
	WHERE photo.status = 'published' AND photo.deleted_at IS NULL
		AND album.status = 'published' AND album.deleted_at IS NULL
		AND json_extract(live.data, '$.image.id') IN (SELECT value FROM json_each(?1))
`;

// Same answer, but only photos whose live image id is indexed are read
// (src/utils/ref-index.mjs); every condition is re-checked on the live rows.
// Look refs up by (kind, value) only: a source condition lets SQLite pick the
// per-source index and read every photo ref (~4k rows) instead. CROSS JOIN
// fixes the join order (requested ids, then their photos): D1's planner
// otherwise starts from every published photo (~4.4k rows).
export const INDEXED_ARTICLE_PHOTO_LINKS_QUERY = `
	SELECT photo.id, json_extract(live.data, '$.image.id') AS media_id
	FROM (
		SELECT DISTINCT ref.source_id
		FROM json_each(?1) AS wanted
		CROSS JOIN kanouk_ref_index AS ref
			ON ref.kind = 'photo:image' AND ref.value = wanted.value
	) AS candidate
	CROSS JOIN ec_photos AS photo ON photo.id = candidate.source_id
	CROSS JOIN revisions AS live ON live.id = photo.live_revision_id
	CROSS JOIN ec_albums AS album ON album.id = json_extract(live.data, '$.album')
	WHERE photo.status = 'published' AND photo.deleted_at IS NULL
		AND album.status = 'published' AND album.deleted_at IS NULL
		AND json_extract(live.data, '$.image.id') IN (SELECT value FROM json_each(?1))
`;

import { digestKey, edgeMemo } from "./edge-memo.mjs";
import { refIndexIsClean } from "./ref-index.mjs";

async function photoLinkRows(database, idList) {
	if (await refIndexIsClean(database)) {
		try {
			return (await database.prepare(INDEXED_ARTICLE_PHOTO_LINKS_QUERY).bind(idList).all()).results;
		} catch {
			// Fall back to the full scan below.
		}
	}
	return (await database.prepare(ARTICLE_PHOTO_LINKS_QUERY).bind(idList).all()).results;
}

export async function articlePhotoLinks(database, content) {
	const mediaIds = [...new Set((content ?? []).filter(block => block?._type === "image")
		.map(block => block.asset?._ref).filter(id => typeof id === "string" && id.length > 0))];
	if (mediaIds.length === 0) return new Map();
	const idList = JSON.stringify([...mediaIds].sort());
	// A few minutes of staleness only delays a new photo link, so the rows are
	// shared across renders.
	const results = await edgeMemo(`article-photo-links:${await digestKey(idList)}`, 300,
		() => photoLinkRows(database, idList), { scope: database });
	const candidates = new Map();
	for (const row of results) {
		if (typeof row.media_id !== "string" || typeof row.id !== "string") continue;
		const ids = candidates.get(row.media_id) ?? new Set();
		ids.add(row.id);
		candidates.set(row.media_id, ids);
	}
	return new Map([...candidates].filter(([, ids]) => ids.size === 1).map(([id, ids]) => [id, [...ids][0]]));
}
