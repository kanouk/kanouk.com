import { sql } from "kysely";
import { getDb } from "emdash/runtime";

/** Published, non-deleted posts: one COUNT(*), never the posts themselves. */
export async function countPublishedPosts(): Promise<number> {
	const db = await getDb();
	const result = await sql<{ total: number }>`SELECT count(*) AS total FROM ec_posts WHERE status='published' AND deleted_at IS NULL`.execute(db);
	return Number(result.rows[0]?.total ?? 0);
}
