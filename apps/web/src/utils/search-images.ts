import { sql, type Kysely } from "kysely";

type SearchHit = { collection: string; id: string };

/**
 * The live photo image or album cover for each search hit, so results can be shown as pictures.
 * Photos whose album is deleted or not published get no entry: they are not public.
 */
export async function searchResultImages(hits: SearchHit[], database?: Kysely<any>): Promise<Map<string, unknown>> {
	const images = new Map<string, unknown>();
	const ids = (collection: string) => hits.filter((hit) => hit.collection === collection).map((hit) => hit.id);
	const photos = ids("photos");
	const albums = ids("albums");
	if (!photos.length && !albums.length) return images;
	const db = database ?? await (await import("emdash/runtime")).getDb();
	const read = async (table: "ec_photos" | "ec_albums", field: string, wanted: string[]) => {
		if (!wanted.length) return;
		const publicAlbum = table === "ec_photos"
			? sql`JOIN ec_albums a ON a.id = json_extract(live.data, '$.album') AND a.status = 'published' AND a.deleted_at IS NULL`
			: sql``;
		const result = await sql<{ id: string; image: string | null }>`
			SELECT c.id, json_extract(live.data, ${`$.${field}`}) AS image
			FROM ${sql.table(table)} c JOIN revisions live ON live.id = c.live_revision_id ${publicAlbum}
			WHERE c.id IN (${sql.join(wanted)})`.execute(db);
		for (const row of result.rows) {
			let image: unknown = null;
			try { image = row.image ? JSON.parse(row.image) : null; } catch { /* not an image value */ }
			images.set(row.id, image);
		}
	};
	await Promise.all([read("ec_photos", "image", photos), read("ec_albums", "cover_image", albums)]);
	return images;
}
