import { env } from "virtual:emdash/env";

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
			WITH sortable AS (
				SELECT id,
				       position,
				       unixepoch(captured_at) AS captured_epoch
				FROM ec_photos
				WHERE status = 'published'
				  AND deleted_at IS NULL
				  AND album = ?1
			),
			ordered AS (
				SELECT id,
				       ROW_NUMBER() OVER (
					       ORDER BY captured_epoch IS NULL ASC, captured_epoch ASC, position ASC, id ASC
				       ) AS position_index,
				       COUNT(*) OVER () AS total_count,
				       LAG(id) OVER (
					       ORDER BY captured_epoch IS NULL ASC, captured_epoch ASC, position ASC, id ASC
				       ) AS previous_id,
				       LEAD(id) OVER (
					       ORDER BY captured_epoch IS NULL ASC, captured_epoch ASC, position ASC, id ASC
				       ) AS next_id,
				       FIRST_VALUE(id) OVER (
					       ORDER BY captured_epoch IS NULL ASC, captured_epoch ASC, position ASC, id ASC
				       ) AS first_id
				FROM sortable
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
