import { classifyMediaRead, type PublicMediaDatabase } from "../studio/public-media-guard.ts";

const DEFAULT_BLOG_ORIGIN = "https://blog.kanouk.com";
const DEFAULT_PHOTO_ORIGIN = "https://photos.kanouk.com";
const DEFAULT_FALLBACK_IMAGE = "/kanolog-no-image.png";
const DESCRIPTION_LENGTH = 180;
const RAW_MEDIA_PATH = /^\/_emdash\/api\/media\/file\/.+$/;
const RESPONSIVE_PREVIEW_PATH = /^\/_yohaku\/media\/preview-v2\/(320|480|768|1200|1600)\/(avif|webp)\/(.+)$/;
const LEGACY_WORDPRESS_HOSTS = new Set(["kanolog.net", "www.kanolog.net", "nocalog.net", "www.nocalog.net", "art-quiz.com", "www.art-quiz.com"]);
const INTERNAL_HOSTS = new Set([
	"blog.kanouk.com",
	"blog-staging.kanouk.com",
	"photos.kanouk.com",
	"photos-staging.kanouk.com",
	"kanouk-emdash-staging.kanouk.workers.dev",
	"localhost",
	"127.0.0.1",
]);

interface D1StatementLike {
	bind(...values: unknown[]): {
		first<T>(): Promise<T | null>;
	};
}

export interface ArticleSocialDatabase extends PublicMediaDatabase {
	prepare(query: string): D1StatementLike;
}

type UnknownRecord = Record<string, unknown>;

export interface ArticleSocialInput {
	id?: string;
	seo?: unknown;
	data: UnknownRecord;
}

export interface ArticleSocialResult {
	description: string;
	imageUrl: string;
}

export interface InternalLinkPreview {
	url: string;
	title: string;
	description: string;
	imageUrl: string;
}

export interface ArticleSocialOptions {
	origin?: string;
	fallbackImagePath?: string;
	isPreview?: boolean;
}

interface PublicContentRow {
	id: string;
	slug: string | null;
	data: string;
	seo_image: string | null;
	seo_description: string | null;
}

interface RelatedMediaRow {
	id: string;
	slug: string | null;
	data: string;
}

function record(value: unknown): UnknownRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function contentBlocks(value: unknown): UnknownRecord[] {
	return Array.isArray(value) ? value.filter((item): item is UnknownRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function plainTextExcerpt(content: unknown, maxLength = DESCRIPTION_LENGTH): string {
	const parts: string[] = [];
	for (const block of contentBlocks(content)) {
		if (block._type !== "block" || !Array.isArray(block.children)) continue;
		const line = block.children
			.map((child) => record(child))
			.filter((child) => child._type === "span")
			.map((child) => text(child.text))
			.join("");
		if (line) parts.push(line);
	}
	const normalized = parts.join(" ").replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function articleDescription(article: ArticleSocialInput): string {
	const seo = record(article.seo ?? article.data.seo);
	return text(seo.description) || text(article.data.excerpt) || plainTextExcerpt(article.data.content);
}

function isLegacyWordPressMediaUrl(value: string): boolean {
	try {
		const candidate = new URL(value);
		return LEGACY_WORDPRESS_HOSTS.has(candidate.hostname.toLowerCase()) && candidate.pathname.startsWith("/wp-content/uploads/");
	} catch {
		return false;
	}
}

function absoluteUrl(value: string, origin: string): string {
	try {
		return new URL(value, origin).toString();
	} catch {
		return "";
	}
}

function photoOriginFor(origin: string): string {
	let candidate: URL;
	try {
		candidate = new URL(origin);
	} catch {
		return DEFAULT_PHOTO_ORIGIN;
	}
	if (candidate.hostname === "blog-staging.kanouk.com") return "https://photos-staging.kanouk.com";
	if (candidate.hostname === "blog.kanouk.com") return DEFAULT_PHOTO_ORIGIN;
	if (INTERNAL_HOSTS.has(candidate.hostname)) return candidate.origin;
	return DEFAULT_PHOTO_ORIGIN;
}

async function mediaStorageKey(
	database: ArticleSocialDatabase,
	reference: string,
): Promise<string> {
	if (!reference) return "";
	const row = await database.prepare(`
		SELECT storage_key
		FROM media
		WHERE status = 'ready' AND (id = ?1 OR storage_key = ?1)
		LIMIT 1
	`).bind(reference).first<{ storage_key: string }>();
	return text(row?.storage_key);
}

async function mappedLegacyMediaUrl(
	database: ArticleSocialDatabase,
	sourceUrl: string,
): Promise<string> {
	const row = await database.prepare(`
		SELECT json_extract(live.data, '$.target_url') AS target_url
		FROM ec_url_mappings AS mapping
		JOIN revisions AS live ON live.id = mapping.live_revision_id
		WHERE mapping.status = 'published' AND mapping.deleted_at IS NULL
			AND json_extract(live.data, '$.source_url') = ?1
			AND json_extract(live.data, '$.target_kind') IN ('media', 'image')
			AND json_extract(live.data, '$.verified') = 1
		LIMIT 1
	`).bind(sourceUrl).first<{ target_url: string | null }>();
	return text(row?.target_url);
}

async function publicImageUrl(
	database: ArticleSocialDatabase,
	value: unknown,
	origin: string,
	allowLegacyMapping = true,
): Promise<string> {
	let candidate = "";
	if (typeof value === "string") {
		candidate = value.trim();
		if (candidate.startsWith("{")) {
			try {
				const parsed = JSON.parse(candidate);
				if (record(parsed).mediaId) return publicImageUrl(database, parsed, origin, allowLegacyMapping);
			} catch {
				return "";
			}
		}
	} else {
		const media = record(value);
		const metadata = record(media.meta);
		const reference = text(media.id) || text(media.mediaId) || text(media._ref) || text(metadata.storageKey);
		const storageKey = await mediaStorageKey(database, reference);
		if (storageKey) candidate = `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`;
		if (!candidate && text(metadata.storageKey)) candidate = `/_emdash/api/media/file/${encodeURIComponent(text(metadata.storageKey))}`;
		if (!candidate) candidate = text(media.src) || text(media.url);
	}
	if (!candidate) return "";
	if (!candidate.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
		const storageKey = await mediaStorageKey(database, candidate);
		if (storageKey) candidate = `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`;
		else if (!candidate.includes("/")) return "";
	}

	if (isLegacyWordPressMediaUrl(candidate)) {
		if (!allowLegacyMapping) return "";
		const mapped = await mappedLegacyMediaUrl(database, candidate);
		if (!mapped) return "";
		return publicImageUrl(database, mapped, origin, false);
	}

	const resolved = absoluteUrl(candidate, origin);
	if (!resolved) return "";
	const parsed = new URL(resolved);
	if (parsed.username || parsed.password) return "";
	const ownHost = INTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ownHost)) return "";
	const preview = parsed.pathname.match(RESPONSIVE_PREVIEW_PATH);
	if (preview) {
		let storageKey: string;
		try {
			storageKey = decodeURIComponent(preview[3]);
		} catch {
			return "";
		}
		if (!storageKey || storageKey.includes("\0") || storageKey.startsWith("backups/")) return "";
		const rawUrl = new URL(
			`/_emdash/api/media/file/${encodeURIComponent(storageKey)}`,
			parsed.origin,
		).toString();
		const access = await classifyMediaRead(new Request(rawUrl), database);
		return access.access === "public" ? rawUrl : "";
	}
	if (parsed.pathname.startsWith("/_yohaku/")) return "";
	if (parsed.pathname.startsWith("/_emdash/") && !RAW_MEDIA_PATH.test(parsed.pathname)) return "";
	if (!RAW_MEDIA_PATH.test(parsed.pathname)) return resolved;
	const access = await classifyMediaRead(new Request(resolved), database);
	return access.access === "public" ? resolved : "";
}

async function publishedPhotoImage(
	database: ArticleSocialDatabase,
	photoReference: string,
	albumReference: string,
): Promise<unknown> {
	if (!photoReference || !albumReference) return null;
	const row = await database.prepare(`
		SELECT photo_live.data
		FROM ec_photos AS photo
		JOIN revisions AS photo_live ON photo_live.id = photo.live_revision_id
		JOIN ec_albums AS album ON album.id = json_extract(photo_live.data, '$.album')
		WHERE photo.status = 'published' AND photo.deleted_at IS NULL
			AND album.status = 'published' AND album.deleted_at IS NULL
			AND (photo.id = ?1 OR photo.slug = ?1)
			AND (album.id = ?2 OR album.slug = ?2)
		LIMIT 1
	`).bind(photoReference, albumReference).first<{ data: string }>();
	if (!row) return null;
	return record(JSON.parse(row.data)).image;
}

async function publishedAlbumCover(
	database: ArticleSocialDatabase,
	albumReference: string,
): Promise<unknown> {
	if (!albumReference) return null;
	const row = await database.prepare(`
		SELECT live.data
		FROM ec_albums AS album
		JOIN revisions AS live ON live.id = album.live_revision_id
		WHERE album.status = 'published' AND album.deleted_at IS NULL
			AND (album.id = ?1 OR album.slug = ?1)
		LIMIT 1
	`).bind(albumReference).first<{ data: string }>();
	if (!row) return null;
	return record(JSON.parse(row.data)).cover_image;
}

async function firstBodyImage(
	database: ArticleSocialDatabase,
	content: unknown,
	origin: string,
): Promise<string> {
	for (const block of contentBlocks(content)) {
		let candidate: unknown = null;
		if (block._type === "image") {
			candidate = block.asset;
		} else if (block._type === "yohaku.photo") {
			candidate = await publishedPhotoImage(database, text(block.id), text(block.albumId));
		} else if (block._type === "yohaku.album") {
			candidate = await publishedAlbumCover(database, text(block.id));
		} else {
			continue;
		}
		const resolved = await publicImageUrl(database, candidate, block._type === "image" ? origin : photoOriginFor(origin));
		if (resolved) return resolved;
	}
	return "";
}

async function siteDefaultImage(
	database: ArticleSocialDatabase,
	origin: string,
): Promise<string> {
	const row = await database.prepare(
		"SELECT value FROM options WHERE name = 'site:seo' LIMIT 1",
	).bind().first<{ value: string }>();
	if (!row?.value) return "";
	const settings = parseJsonData(row.value);
	return settings ? publicImageUrl(database, settings.defaultOgImage, origin) : "";
}

export async function resolveArticleSocial(
	database: ArticleSocialDatabase,
	article: ArticleSocialInput,
	options: ArticleSocialOptions = {},
): Promise<ArticleSocialResult> {
	const origin = options.origin ?? DEFAULT_BLOG_ORIGIN;
	const fallback = absoluteUrl(options.fallbackImagePath ?? DEFAULT_FALLBACK_IMAGE, origin);
	if (options.isPreview) {
		const reference = text(article.data.id) || text(article.id);
		const live = reference ? await publicContentRow(database, "posts", reference) : null;
		const data = live ? parseJsonData(live.data) : null;
		if (!live || !data) {
			return {
				description: "",
				imageUrl: await siteDefaultImage(database, origin) || fallback,
			};
		}
		return resolveArticleSocial(database, {
			id: live.id,
			data: {
				...data,
				seo: { ...record(data.seo), image: live.seo_image, description: live.seo_description },
			},
		}, { ...options, isPreview: false });
	}
	const seo = record(article.seo ?? article.data.seo);
	const candidates = [seo.image, article.data.featured_image];
	for (const candidate of candidates) {
		const resolved = await publicImageUrl(database, candidate, origin);
		if (resolved) return { description: articleDescription(article), imageUrl: resolved };
	}
	const bodyImage = await firstBodyImage(database, article.data.content, origin);
	return {
		description: articleDescription(article),
		imageUrl: bodyImage || await siteDefaultImage(database, origin) || fallback,
	};
}

function parseJsonData(value: string): UnknownRecord | null {
	try {
		return record(JSON.parse(value));
	} catch {
		return null;
	}
}

function decodedPathReference(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return "";
	}
}

async function publicContentRow(
	database: ArticleSocialDatabase,
	collection: "posts" | "pages",
	reference: string,
): Promise<PublicContentRow | null> {
	return database.prepare(`
		SELECT entry.id, entry.slug, live.data,
			seo.seo_image, seo.seo_description
		FROM ec_${collection} AS entry
		JOIN revisions AS live ON live.id = entry.live_revision_id
		LEFT JOIN _emdash_seo AS seo
			ON seo.collection = '${collection}' AND seo.content_id = entry.id
		WHERE entry.status = 'published' AND entry.deleted_at IS NULL
			AND (entry.id = ?1 OR entry.slug = ?1)
		LIMIT 1
	`).bind(reference).first<PublicContentRow>();
}

async function mappedInternalUrl(database: ArticleSocialDatabase, sourceUrl: string): Promise<string> {
	const row = await database.prepare(`
		SELECT json_extract(live.data, '$.target_url') AS target_url
		FROM ec_url_mappings AS mapping
		JOIN revisions AS live ON live.id = mapping.live_revision_id
		WHERE mapping.status = 'published' AND mapping.deleted_at IS NULL
			AND json_extract(live.data, '$.source_url') = ?1
			AND json_extract(live.data, '$.target_kind') IN ('post', 'page')
		LIMIT 1
	`).bind(sourceUrl).first<{ target_url: string | null }>();
	return text(row?.target_url);
}

async function publicRelatedMediaRow(
	database: ArticleSocialDatabase,
	collection: "photos" | "albums",
	reference: string,
): Promise<RelatedMediaRow | null> {
	return database.prepare(`
		SELECT entry.id, entry.slug, live.data
		FROM ec_${collection} AS entry
		JOIN revisions AS live ON live.id = entry.live_revision_id
		WHERE entry.status = 'published' AND entry.deleted_at IS NULL
			AND (entry.id = ?1 OR entry.slug = ?1)
		LIMIT 1
	`).bind(reference).first<RelatedMediaRow>();
}

export async function resolveInternalLinkPreview(
	database: ArticleSocialDatabase,
	url: string,
	options: { origin?: string } = {},
): Promise<InternalLinkPreview | null> {
	const origin = options.origin ?? DEFAULT_BLOG_ORIGIN;
	let candidate: URL;
	try {
		candidate = new URL(url, origin);
	} catch {
		return null;
	}
	if (!new Set(["http:", "https:"]).has(candidate.protocol) || candidate.username || candidate.password) return null;
	if (candidate.searchParams.has("_preview") || candidate.pathname.startsWith("/_emdash/")) return null;

	if (LEGACY_WORDPRESS_HOSTS.has(candidate.hostname.toLowerCase())) {
		if (candidate.port) return null;
		const target = await mappedInternalUrl(database, candidate.toString());
		if (!target || target === candidate.toString()) return null;
		let mapped: URL;
		try {
			mapped = new URL(target, origin);
		} catch {
			return null;
		}
		if (!INTERNAL_HOSTS.has(mapped.hostname.toLowerCase())) return null;
		if (!/^\/(posts|pages)\/[^/]+\/?$/.test(mapped.pathname)) return null;
		return resolveInternalLinkPreview(database, mapped.toString(), options);
	}
	if (!INTERNAL_HOSTS.has(candidate.hostname.toLowerCase())) return null;

	const contentMatch = candidate.pathname.match(/^\/(posts|pages)\/([^/]+)\/?$/);
	if (contentMatch) {
		const collection = contentMatch[1] as "posts" | "pages";
		const reference = decodedPathReference(contentMatch[2]);
		if (!reference) return null;
		const row = await publicContentRow(database, collection, reference);
		if (!row) return null;
		const data = parseJsonData(row.data);
		if (!data) return null;
		const article = {
			id: row.id,
			data: {
				...data,
				seo: { ...record(data.seo), image: row.seo_image, description: row.seo_description },
			},
		};
		const social = await resolveArticleSocial(database, article, { origin });
		return {
			url: new URL(`/${collection}/${encodeURIComponent(row.id)}`, origin).toString(),
			title: text(data.title),
			description: social.description,
			imageUrl: social.imageUrl,
		};
	}

	const photoMatch = candidate.pathname.match(/^\/p\/([^/]+)\/?$/);
	if (photoMatch) {
		const reference = decodedPathReference(photoMatch[1]);
		if (!reference) return null;
		const row = await publicRelatedMediaRow(database, "photos", reference);
		const data = row && parseJsonData(row.data);
		const albumReference = data ? text(data.album) : "";
		const image = row && data ? await publishedPhotoImage(database, row.id, albumReference) : null;
		if (!row || !data || !image) return null;
		const photoOrigin = photoOriginFor(origin);
		const imageUrl = await publicImageUrl(database, image, photoOrigin);
		if (!imageUrl) return null;
		return {
			url: new URL(`/p/${encodeURIComponent(row.id)}`, photoOrigin).toString(),
			title: text(data.title) || text(data.caption) || "写真",
			description: text(data.caption),
			imageUrl,
		};
	}

	const albumMatch = candidate.pathname.match(/^\/albums\/([^/]+)\/?$/);
	if (albumMatch) {
		const reference = decodedPathReference(albumMatch[1]);
		if (!reference) return null;
		const row = await publicRelatedMediaRow(database, "albums", reference);
		const data = row && parseJsonData(row.data);
		if (!row || !data) return null;
		const photoOrigin = photoOriginFor(origin);
		const imageUrl = await publicImageUrl(database, data.cover_image, photoOrigin);
		return {
			url: new URL(`/albums/${encodeURIComponent(row.id)}`, photoOrigin).toString(),
			title: text(data.title),
			description: text(data.description),
			imageUrl: imageUrl || absoluteUrl(DEFAULT_FALLBACK_IMAGE, photoOrigin),
		};
	}

	return null;
}
