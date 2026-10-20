import { sql, type Kysely } from "kysely";

/** The manual album order saved by the photo organizer plugin (src/studio/runtime.ts, "album-order"). */
export async function readSavedAlbumOrder(database?: Kysely<any>): Promise<string[]> {
	try {
		const db = database ?? await (await import("emdash/runtime")).getDb();
		const result = await sql<{ data: string }>`SELECT data FROM _plugin_storage
			WHERE plugin_id = 'yohaku-photo-tools' AND collection = 'settings' AND id = 'album-order'`.execute(db);
		const ids = JSON.parse(result.rows[0]?.data ?? "{}")?.ids;
		return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
	} catch {
		// No saved order (or storage not created yet): the default order applies.
		return [];
	}
}
