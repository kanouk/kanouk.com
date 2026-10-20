import { env } from "virtual:emdash/env";
import { photoOrderSql, sqlSortDirection, sqlSortMethod } from "./photo-sort.mjs";

// Previous/next follow the album's own sort (SmugMug's per-gallery "Sort By").
const ORDER = photoOrderSql("s.m", "s.d", {
	captured: "captured_epoch", position: "position", filename: "filename",
	caption: "caption", created: "created_at", updated: "updated_at", id: "id",
});

interface NavigationRow {
	previous_id: string | null;
	next_id: string | null;
	first_id: string | null;
	position_index: number;
	total_count: number;
}

interface D1StatementLike {
	bind(...values: unknown[]): D1StatementLike;
	all<T>(): Promise<{ results: T[] }>;
}

interface D1DatabaseLike {
	prepare(query: string): D1StatementLike;
}

export interface PhotoNavigation {
	previousId?: string;
	nextId?: string;
	firstId?: string;
	position: number;
	total: number;
}

export async function getPhotoNavigation(
	albumId: string,
	photoId: string,
): Promise<PhotoNavigation | null> {
	const database = env?.DB as D1DatabaseLike | undefined;
	if (!database) throw new Error("Cloudflare D1 binding DB is unavailable");

	const result = await database
		.prepare(`
			WITH s AS (
				SELECT ${sqlSortMethod("sort_method")} AS m, ${sqlSortDirection("sort_direction")} AS d
				FROM ec_albums WHERE id = ?1
				UNION ALL SELECT 'date taken', 'asc' WHERE NOT EXISTS (SELECT 1 FROM ec_albums WHERE id = ?1)
			),
			sortable AS (
				SELECT id,
				       position,
				       unixepoch(captured_at) AS captured_epoch,
				       json_extract(image, '$.filename') AS filename,
				       caption,
				       created_at,
				       updated_at
				FROM ec_photos
				WHERE status = 'published'
				  AND deleted_at IS NULL
				  AND album = ?1
			),
			ordered AS (
				SELECT id,
				       ROW_NUMBER() OVER (
					       ORDER BY ${ORDER}
				       ) AS position_index,
				       COUNT(*) OVER () AS total_count,
				       LAG(id) OVER (
					       ORDER BY ${ORDER}
				       ) AS previous_id,
				       LEAD(id) OVER (
					       ORDER BY ${ORDER}
				       ) AS next_id,
				       FIRST_VALUE(id) OVER (
					       ORDER BY ${ORDER}
				       ) AS first_id
				FROM sortable, s
			)
			SELECT previous_id, next_id, first_id, position_index, total_count
			FROM ordered
			WHERE id = ?2
			LIMIT 1
		`)
		.bind(albumId, photoId)
		.all<NavigationRow>();

	const row = result.results[0];
	if (!row) return null;
	return {
		previousId: row.previous_id || undefined,
		nextId: row.next_id || undefined,
		firstId: row.first_id || undefined,
		position: Number(row.position_index),
		total: Number(row.total_count),
	};
}
