import type { MediaValue } from "emdash";
import { sql, type Kysely } from "kysely";
import { resolveImageSource } from "./image-source.ts";

type CoverPost = { data: { id: string; featured_image?: unknown; related_album?: unknown } };

/**
 * The image each post card shows, keyed by post id: the post's own cover, or else
 * the live cover of its related album. Albums that are deleted or not published
 * are not public, so they supply nothing. Posts with neither get no entry.
 */
export async function postCoverImages(posts: CoverPost[], database?: Kysely<any>): Promise<Map<string, MediaValue | string>> {
	const covers = new Map<string, MediaValue | string>();
	const waiting = new Map<string, string[]>();
	for (const { data } of posts) {
		if (resolveImageSource(data.featured_image)) {
			covers.set(data.id, data.featured_image as MediaValue | string);
		} else if (typeof data.related_album === "string" && data.related_album) {
			waiting.set(data.related_album, [...(waiting.get(data.related_album) ?? []), data.id]);
		}
	}
	if (!waiting.size) return covers;
	const db = database ?? await (await import("emdash/runtime")).getDb();
	const result = await sql<{ id: string; image: string | null }>`
		SELECT album.id, json_extract(live.data, '$.cover_image') AS image
		FROM ec_albums album JOIN revisions live ON live.id = album.live_revision_id
		WHERE album.id IN (${sql.join([...waiting.keys()])})
			AND album.status = 'published' AND album.deleted_at IS NULL`.execute(db);
	for (const row of result.rows) {
		let image: unknown = null;
		try { image = row.image ? JSON.parse(row.image) : null; } catch { /* not an image value */ }
		if (!resolveImageSource(image)) continue;
		for (const postId of waiting.get(row.id) ?? []) covers.set(postId, image as MediaValue);
	}
	return covers;
}
