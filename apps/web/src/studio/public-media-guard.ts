const RAW_MEDIA_ROUTE = /^\/_emdash\/api\/media\/file\/(.*)$/;
const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);
const BLOG_HOSTS = new Set(["blog.kanouk.com", "blog-staging.kanouk.com"]);
const PUBLIC_HOSTS = new Set([
	...PHOTO_HOSTS,
	...BLOG_HOSTS,
	"localhost",
	"127.0.0.1",
	"kanouk-emdash-staging.kanouk.workers.dev",
]);
const PRIVATE_CACHE_CONTROL = "private, no-store";

export interface PublicMediaDatabase {
	prepare(query: string): {
		bind(...values: unknown[]): {
			first<T>(): Promise<T | null>;
		};
	};
}

export type MediaReadAccess = "not-media" | "public" | "authenticated" | "denied";

export interface MediaReadClassification {
	access: MediaReadAccess;
	storageKey?: string;
}

export interface ClassifyMediaReadOptions {
	authenticate?: (request: Request) => Promise<boolean>;
}

/**
 * The raw media endpoint is public in EmDash itself, so this classifier is the
 * authority for reads that reach our Worker. Only exact media-bearing fields
 * in the current live revision count as a public reference.
 */
export async function classifyMediaRead(
	request: Request,
	database: PublicMediaDatabase,
	options: ClassifyMediaReadOptions = {},
): Promise<MediaReadClassification> {
	const url = new URL(request.url);
	const match = url.pathname.match(RAW_MEDIA_ROUTE);
	if (!match) return { access: "not-media" };
	if (request.method !== "GET" && request.method !== "HEAD") return { access: "denied" };

	let storageKey: string;
	try {
		storageKey = decodeURIComponent(match[1]);
	} catch {
		return { access: "denied" };
	}
	if (!storageKey || storageKey.includes("\0") || storageKey.startsWith("backups/")) {
		return { access: "denied", storageKey };
	}

	if (PUBLIC_HOSTS.has(url.hostname)) {
		try {
			if (await isCurrentPublicMedia(database, storageKey)) {
				return { access: "public", storageKey };
			}
		} catch {
			// Projection/schema/database failures must never turn into public access.
		}
	}

	try {
		if (await options.authenticate?.(request)) {
			return { access: "authenticated", storageKey };
		}
	} catch {
		// Authentication failures are intentionally indistinguishable from denial.
	}
	return { access: "denied", storageKey };
}

async function isCurrentPublicMedia(
	database: PublicMediaDatabase,
	storageKey: string,
): Promise<boolean> {
	const encodedPath = `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`;
	const unescapedPath = `/_emdash/api/media/file/${storageKey}`;
	const canonicalAbsolutePaths = [
		"https://blog.kanouk.com",
		"https://blog-staging.kanouk.com",
		"https://photos.kanouk.com",
		"https://photos-staging.kanouk.com",
		"https://kanouk-emdash-staging.kanouk.workers.dev",
	].map((origin) => `${origin}${encodedPath}`);
	const allowed = await database.prepare(`
		WITH requested_media AS (
			SELECT id, storage_key
			FROM media
			WHERE storage_key = ?1
			LIMIT 1
		), current_public_content AS (
			SELECT post.live_revision_id, live.data
			FROM ec_posts AS post
			JOIN revisions AS live ON live.id = post.live_revision_id
			WHERE post.status = 'published' AND post.deleted_at IS NULL
			UNION ALL
			SELECT page.live_revision_id, live.data
			FROM ec_pages AS page
			JOIN revisions AS live ON live.id = page.live_revision_id
			WHERE page.status = 'published' AND page.deleted_at IS NULL
		), current_public_albums AS (
			SELECT live.data
			FROM ec_albums AS album
			JOIN revisions AS live ON live.id = album.live_revision_id
			WHERE album.status = 'published' AND album.deleted_at IS NULL
		), exact_media_reference(value) AS (
			VALUES (?1), (?2), (?3), (?4), (?5), (?6), (?7), (?8)
		)
		SELECT 1 AS allowed
		WHERE NOT EXISTS (
			SELECT 1
			FROM ec_photos AS photo
			JOIN revisions AS candidate
				ON candidate.id IN (photo.live_revision_id, photo.draft_revision_id)
			WHERE json_extract(candidate.data, '$.source_metadata.photo_organizer_upload') = 1
				AND COALESCE(json_extract(candidate.data, '$.source_metadata.location_review'), '') != 'clean'
				AND (
					json_extract(candidate.data, '$.image.meta.storageKey') = ?1
					OR json_extract(candidate.data, '$.video.meta.storageKey') = ?1
					OR json_extract(candidate.data, '$.image.id') = (SELECT id FROM requested_media)
					OR json_extract(candidate.data, '$.video.id') = (SELECT id FROM requested_media)
				)
		) AND (
		EXISTS (
			SELECT 1
			FROM ec_photos AS photo
			JOIN revisions AS live ON live.id = photo.live_revision_id
			WHERE photo.status = 'published'
				AND photo.deleted_at IS NULL
				AND (
					json_extract(live.data, '$.image.meta.storageKey') = ?1
					OR json_extract(live.data, '$.video.meta.storageKey') = ?1
					OR json_extract(live.data, '$.image.id') = (SELECT id FROM requested_media)
					OR json_extract(live.data, '$.video.id') = (SELECT id FROM requested_media)
				)
				AND (
					COALESCE(json_extract(live.data, '$.source_metadata.photo_organizer_upload'), 0) != 1
					OR json_extract(live.data, '$.source_metadata.location_review') = 'clean'
				)
		) OR EXISTS (
			SELECT 1
			FROM current_public_content AS content
			WHERE (
				json_extract(content.data, '$.featured_image.id') = (SELECT id FROM requested_media)
				OR json_extract(content.data, '$.featured_image.meta.storageKey') = ?1
				OR json_extract(content.data, '$.featured_image.src') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
				OR json_extract(content.data, '$.featured_image.url') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
				OR EXISTS (
					SELECT 1
					FROM json_each(content.data, '$.content') AS block
					WHERE (
						json_extract(block.value, '$._type') = 'image'
						AND (
							json_extract(block.value, '$.asset._ref') = (SELECT id FROM requested_media)
							OR json_extract(block.value, '$.asset.url') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
						)
					) OR (
						json_extract(block.value, '$._type') IN ('yohaku.linkCard', 'yohaku.productCard')
						AND json_extract(block.value, '$.imageUrl') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
					) OR (
						json_extract(block.value, '$._type') = 'yohaku.dialogue'
						AND json_extract(block.value, '$.avatarUrl') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
					) OR (
						json_extract(block.value, '$._type') IN ('gallery', 'yohaku.gallery')
						AND EXISTS (
							SELECT 1
							FROM json_each(block.value, '$.images') AS gallery_image
							WHERE json_extract(gallery_image.value, '$.asset._ref') = (SELECT id FROM requested_media)
								OR json_extract(gallery_image.value, '$.asset.url') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
								OR json_extract(gallery_image.value, '$.src') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
						)
					) OR (
						json_extract(block.value, '$._type') = 'htmlBlock'
						AND EXISTS (
							SELECT 1
							FROM exact_media_reference AS reference
							WHERE instr(json_extract(block.value, '$.html'), 'src="' || reference.value || '"') > 0
								OR instr(json_extract(block.value, '$.html'), 'src=''' || reference.value || '''') > 0
						)
					)
				)
			)
		) OR EXISTS (
			SELECT 1
			FROM current_public_albums AS album
			WHERE json_extract(album.data, '$.cover_image.id') = (SELECT id FROM requested_media)
				OR json_extract(album.data, '$.cover_image.meta.storageKey') = ?1
				OR json_extract(album.data, '$.cover_image.src') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
				OR json_extract(album.data, '$.cover_image.url') IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		) OR EXISTS (
			SELECT 1
			FROM options AS setting
			WHERE setting.name = 'site:seo'
				AND json_extract(setting.value, '$.defaultOgImage.mediaId') = (SELECT id FROM requested_media)
		)
		)
		LIMIT 1
	`).bind(
		storageKey,
		encodedPath,
		unescapedPath,
		...canonicalAbsolutePaths,
	).first<{ allowed: number }>();
	return allowed?.allowed === 1;
}

export function deniedMediaResponse(): Response {
	return addPrivateMediaHeaders(new Response("Not Found", { status: 404 }));
}

/** Apply the cache boundary required for authenticated-only media and denials. */
export function addPrivateMediaHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", PRIVATE_CACHE_CONTROL);
	appendVary(headers, "Cookie");
	appendVary(headers, "Authorization");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function applyMediaAccessHeaders(
	response: Response,
	access: Extract<MediaReadAccess, "public" | "authenticated">,
): Response {
	return access === "authenticated" ? addPrivateMediaHeaders(response) : response;
}

export function authenticationHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const name of ["Cookie", "Authorization"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

/** Public image transforms must never carry ambient admin credentials. */
export function publicMediaTransformationRequest(sourceUrl: URL): Request {
	return new Request(sourceUrl, { headers: { Accept: "image/*" } });
}

export function mediaPreviewDelivery(
	access: MediaReadAccess,
): "transform-public" | "direct-private" | "deny" {
	if (access === "public") return "transform-public";
	if (access === "authenticated") return "direct-private";
	return "deny";
}

export function hasAuthenticationMaterial(request: Request): boolean {
	return Boolean(request.headers.get("Authorization") || request.headers.get("Cookie"));
}

export function authenticationProbeRequest(request: Request): Request | null {
	if (!hasAuthenticationMaterial(request)) return null;
	const source = new URL(request.url);
	const hostname = source.hostname === "photos.kanouk.com"
		? "blog.kanouk.com"
		: source.hostname === "photos-staging.kanouk.com"
			? "blog-staging.kanouk.com"
			: source.hostname;
	const url = new URL("/_emdash/api/auth/me", source);
	url.hostname = hostname;
	return new Request(url, { method: "GET", headers: authenticationHeaders(request) });
}

export async function verifyAuthenticatedMediaRead(
	request: Request,
	fetchAuth: (request: Request) => Promise<Response>,
): Promise<boolean> {
	const probe = authenticationProbeRequest(request);
	if (!probe) return false;
	try {
		const response = await fetchAuth(probe);
		if (response.status !== 200) return false;
		const payload = await response.json().catch(() => null) as {
			success?: unknown;
			data?: { id?: unknown };
		} | null;
		return payload?.success === true && typeof payload.data?.id === "string" && payload.data.id.length > 0;
	} catch {
		return false;
	}
}

/** Compatibility wrapper for callers that only need allow/deny behavior. */
export async function guardPublicOriginalRead(
	request: Request,
	database: PublicMediaDatabase,
	options: ClassifyMediaReadOptions = {},
): Promise<Response | null> {
	const classification = await classifyMediaRead(request, database, options);
	return classification.access === "denied" ? deniedMediaResponse() : null;
}

function appendVary(headers: Headers, value: string): void {
	const values = (headers.get("Vary") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
	headers.set("Vary", values.join(", "));
}
