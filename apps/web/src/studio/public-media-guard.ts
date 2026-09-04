const RAW_MEDIA_ROUTE = /^\/_emdash\/api\/media\/file\/(.+)$/;
const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);

export interface PublicMediaDatabase {
	prepare(query: string): {
		bind(...values: unknown[]): {
			first<T>(): Promise<T | null>;
		};
	};
}

export async function guardPublicOriginalRead(
	request: Request,
	database: PublicMediaDatabase,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!PHOTO_HOSTS.has(url.hostname) || !new Set(["GET", "HEAD"]).has(request.method)) return null;
	const match = url.pathname.match(RAW_MEDIA_ROUTE);
	if (!match) return null;
	let storageKey: string;
	try {
		storageKey = decodeURIComponent(match[1]);
	} catch {
		return new Response("Not Found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
	}
	const allowed = await database.prepare(`
		SELECT 1 AS allowed
		FROM ec_photos AS photo
		JOIN revisions AS live ON live.id = photo.live_revision_id
		WHERE photo.status = 'published'
			AND photo.deleted_at IS NULL
			AND (
				json_extract(live.data, '$.image.meta.storageKey') = ?1
				OR json_extract(live.data, '$.video.meta.storageKey') = ?1
			)
			AND (
				COALESCE(json_extract(live.data, '$.source_metadata.photo_organizer_upload'), 0) != 1
				OR json_extract(live.data, '$.source_metadata.location_review') = 'clean'
			)
		LIMIT 1
	`).bind(storageKey).first<{ allowed: number }>();
	if (allowed?.allowed === 1) return null;
	return new Response("Not Found", {
		status: 404,
		headers: { "Cache-Control": "private, no-store" },
	});
}
