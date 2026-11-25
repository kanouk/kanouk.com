/**
 * Derived reference index (D1 tables `kanouk_ref_index` / `kanouk_ref_dirty`).
 *
 * Several public reads used to answer "which content references X?" by scanning
 * the JSON of every live revision: the public-media guard (~20k rows per
 * image), the article photo links (~4k rows) and the album's related articles
 * (~240k rows). Concurrent scans tripped D1's "overloaded" limit.
 *
 * The index stores, per content entry, the values those reads look for. It is
 * kept exact by triggers (migrations/kanouk/0001_ref_index.up.sql): every write
 * that can change an answer (status, trash, live/draft revision pointer, the
 * revision data itself, the site SEO option) marks the entry dirty in the same
 * transaction. While any entry is dirty, readers use the original full scan, so
 * the index is only ever consulted when it reflects the committed state. A drain
 * (cron and after a dirty read) recomputes dirty entries; it writes an entry's
 * rows only if the entry's dirty stamp is unchanged, inside one batch, so a
 * concurrent write can never be overwritten by older data.
 */

export const MEDIA_FILE_PATH = "/_emdash/api/media/file/";
export const CANONICAL_MEDIA_ORIGINS = [
	"https://blog.kanouk.com",
	"https://blog-staging.kanouk.com",
	"https://photos.kanouk.com",
	"https://photos-staging.kanouk.com",
	"https://kanouk-emdash-staging.kanouk.workers.dev",
];

// Media allow references. A request for storage key K is public when one of
// these matches and no block reference matches (see mediaAccessFromIndex).
//   media:key  value equals K
//   media:enc  value equals encodeURIComponent(K)
//   media:id   value equals the media row id for K
// Block references (unreviewed Photo Organizer uploads) veto any allow.
//   block:key  value equals K
//   block:id   value equals the media row id for K
// photo:image  published Photo's live image id (article photo links candidates)
// album:ref    related_album / id / url / href values in a published post
export const REF_KINDS = ["media:key", "media:enc", "media:id", "block:key", "block:id", "photo:image", "album:ref"];

const SOURCES = new Set(["posts", "pages", "albums", "photos", "options"]);
const DRAIN_LIMIT = 100;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string";
// json_each over an object iterates its values; over a scalar, nothing usable.
const members = (value) => (Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []);
// json_extract(...) = 1 matches JSON 1, 1.0 and true.
const isOne = (value) => value === 1 || value === true;

function parseJson(text) {
	if (!isString(text)) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * References for a value that the original guard compared against all eight
 * URL forms of the key: K, /path/enc(K), /path/K, and origin/path/enc(K).
 */
export function mediaUrlRefs(value) {
	if (!isString(value)) return [];
	if (value.startsWith(MEDIA_FILE_PATH)) {
		const rest = value.slice(MEDIA_FILE_PATH.length);
		return [["media:key", rest], ["media:enc", rest]];
	}
	for (const origin of CANONICAL_MEDIA_ORIGINS) {
		if (value.startsWith(origin + MEDIA_FILE_PATH)) {
			return [["media:enc", value.slice(origin.length + MEDIA_FILE_PATH.length)]];
		}
	}
	return [["media:key", value]];
}

/** Every quoted src attribute value, matching the guard's instr('src="X"') test. */
export function htmlSrcValues(html) {
	if (!isString(html)) return [];
	const values = [];
	for (const quote of ['"', "'"]) {
		const marker = `src=${quote}`;
		let index = html.indexOf(marker);
		while (index !== -1) {
			const start = index + marker.length;
			const end = html.indexOf(quote, start);
			if (end === -1) break;
			values.push(html.slice(start, end));
			index = html.indexOf(marker, index + 1);
		}
	}
	return values;
}

function imageFieldRefs(field) {
	if (!isObject(field)) return [];
	const refs = [];
	if (isString(field.id)) refs.push(["media:id", field.id]);
	if (isObject(field.meta) && isString(field.meta.storageKey)) refs.push(["media:key", field.meta.storageKey]);
	refs.push(...mediaUrlRefs(field.src), ...mediaUrlRefs(field.url));
	return refs;
}

function blockMediaRefs(block) {
	if (!isObject(block)) return [];
	const asset = isObject(block.asset) ? block.asset : {};
	switch (block._type) {
		case "image":
			return [...(isString(asset._ref) ? [["media:id", asset._ref]] : []), ...mediaUrlRefs(asset.url)];
		case "file":
			return mediaUrlRefs(block.url);
		case "yohaku.linkCard":
		case "yohaku.productCard":
			return mediaUrlRefs(block.imageUrl);
		case "yohaku.dialogue":
			return mediaUrlRefs(block.avatarUrl);
		case "gallery":
		case "yohaku.gallery":
			return members(block.images).flatMap((image) => {
				if (!isObject(image)) return [];
				const imageAsset = isObject(image.asset) ? image.asset : {};
				return [
					...(isString(imageAsset._ref) ? [["media:id", imageAsset._ref]] : []),
					...mediaUrlRefs(imageAsset.url),
					...mediaUrlRefs(image.src),
				];
			});
		case "htmlBlock":
			return htmlSrcValues(block.html).flatMap(mediaUrlRefs);
		default:
			return [];
	}
}

/** Values the album's related-articles query matches (a superset; it re-checks). */
function albumRefs(data) {
	const refs = [];
	if (isString(data.related_album)) refs.push(["album:ref", data.related_album]);
	const visit = (node) => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
		} else if (isObject(node)) {
			for (const [key, child] of Object.entries(node)) {
				if ((key === "id" || key === "url" || key === "href") && isString(child)) refs.push(["album:ref", child]);
				else visit(child);
			}
		}
	};
	visit(data.content);
	return refs;
}

function photoRevisionIsUnreviewed(data) {
	const meta = isObject(data?.source_metadata) ? data.source_metadata : {};
	return isOne(meta.photo_organizer_upload) && !(meta.location_review === "clean" || meta.location_review === "kept");
}

function photoMediaRefs(data, prefix) {
	if (!isObject(data)) return [];
	const refs = [];
	for (const field of [data.image, data.video]) {
		if (!isObject(field)) continue;
		if (isObject(field.meta) && isString(field.meta.storageKey)) refs.push([`${prefix}:key`, field.meta.storageKey]);
		if (isString(field.id)) refs.push([`${prefix}:id`, field.id]);
	}
	return refs;
}

const isLive = (row) => row && row.status === "published" && (row.deleted_at === null || row.deleted_at === undefined);

/**
 * Reference rows for one entry, mirroring the original SQL conditions.
 * `row` is the entry row ({status, deleted_at}) joined with its revision data
 * (`live_data`, and `draft_data` for photos); null when the entry is gone.
 * @returns {Array<[string, string]>} [kind, value] pairs, deduplicated
 */
export function entryRefs(source, row) {
	const refs = [];
	if (source === "options") {
		const value = parseJson(row?.value);
		const mediaId = isObject(value) && isObject(value.defaultOgImage) ? value.defaultOgImage.mediaId : undefined;
		if (isString(mediaId)) refs.push(["media:id", mediaId]);
	} else if (row && source === "photos") {
		const live = parseJson(row.live_data);
		const draft = parseJson(row.draft_data);
		// Any photo (draft, trashed, published) whose live or draft revision awaits
		// location review vetoes its media everywhere.
		for (const data of [live, draft]) {
			if (isObject(data) && photoRevisionIsUnreviewed(data)) refs.push(...photoMediaRefs(data, "block"));
		}
		if (isLive(row) && isObject(live)) {
			const meta = isObject(live.source_metadata) ? live.source_metadata : {};
			if (!isOne(meta.photo_organizer_upload) || meta.location_review === "clean" || meta.location_review === "kept") {
				refs.push(...photoMediaRefs(live, "media"));
			}
			if (isObject(live.image) && isString(live.image.id)) refs.push(["photo:image", live.image.id]);
		}
	} else if (row && isLive(row)) {
		const live = parseJson(row.live_data);
		if (isObject(live)) {
			if (source === "albums") {
				refs.push(...imageFieldRefs(live.cover_image));
			} else {
				refs.push(...imageFieldRefs(live.featured_image));
				refs.push(...members(live.content).flatMap(blockMediaRefs));
				if (source === "posts") refs.push(...albumRefs(live));
			}
		}
	}
	const seen = new Set();
	return refs.filter(([kind, value]) => {
		const key = `${kind}\u0000${value}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const ENTRY_STATE_QUERIES = {
	posts: "ec_posts",
	pages: "ec_pages",
	albums: "ec_albums",
};

async function loadEntryStates(database, source, ids) {
	const idList = JSON.stringify(ids);
	let query;
	if (source === "options") {
		query = `SELECT setting.name AS id, setting.value FROM json_each(?1) AS wanted JOIN options AS setting ON setting.name = wanted.value`;
	} else if (source === "photos") {
		query = `SELECT entry.id, entry.status, entry.deleted_at, live.data AS live_data, draft.data AS draft_data
			FROM json_each(?1) AS wanted
			JOIN ec_photos AS entry ON entry.id = wanted.value
			LEFT JOIN revisions AS live ON live.id = entry.live_revision_id
			LEFT JOIN revisions AS draft ON draft.id = entry.draft_revision_id`;
	} else {
		query = `SELECT entry.id, entry.status, entry.deleted_at, live.data AS live_data
			FROM json_each(?1) AS wanted
			JOIN ${ENTRY_STATE_QUERIES[source]} AS entry ON entry.id = wanted.value
			LEFT JOIN revisions AS live ON live.id = entry.live_revision_id
				AND entry.status = 'published' AND entry.deleted_at IS NULL`;
	}
	const { results } = await database.prepare(query).bind(idList).all();
	return new Map(results.map((row) => [row.id, row]));
}

/**
 * Recompute up to `limit` dirty entries. Safe to run concurrently: each entry's
 * rows are replaced only while its dirty stamp is the one that was read.
 * @returns {Promise<{processed: number, remaining: boolean}>}
 */
export async function drainRefIndex(database, { limit = DRAIN_LIMIT } = {}) {
	const { results: dirty } = await database
		.prepare("SELECT source, source_id, stamp FROM kanouk_ref_dirty LIMIT ?1")
		.bind(limit + 1)
		.all();
	const batch = dirty.slice(0, limit);
	if (batch.length === 0) return { processed: 0, remaining: false };
	const bySource = new Map();
	for (const entry of batch) {
		if (!SOURCES.has(entry.source)) continue;
		const ids = bySource.get(entry.source) ?? [];
		ids.push(entry.source_id);
		bySource.set(entry.source, ids);
	}
	const states = new Map();
	for (const [source, ids] of bySource) states.set(source, await loadEntryStates(database, source, ids));
	const payload = JSON.stringify(batch.map((entry) => ({
		s: entry.source,
		id: entry.source_id,
		stamp: entry.stamp,
		refs: SOURCES.has(entry.source) ? entryRefs(entry.source, states.get(entry.source).get(entry.source_id) ?? null) : [],
	})));
	const current = `
		SELECT dirty.source, dirty.source_id, wanted.value AS item
		FROM json_each(?1) AS wanted
		JOIN kanouk_ref_dirty AS dirty
			ON dirty.source = json_extract(wanted.value, '$.s')
			AND dirty.source_id = json_extract(wanted.value, '$.id')
			AND dirty.stamp = json_extract(wanted.value, '$.stamp')`;
	await database.batch([
		database.prepare(`DELETE FROM kanouk_ref_index WHERE (source, source_id) IN (SELECT source, source_id FROM (${current}))`).bind(payload),
		database.prepare(`INSERT OR IGNORE INTO kanouk_ref_index (kind, value, source, source_id)
			SELECT json_extract(ref.value, '$[0]'), json_extract(ref.value, '$[1]'), item.source, item.source_id
			FROM (${current}) AS item, json_each(item.item, '$.refs') AS ref`).bind(payload),
		database.prepare(`DELETE FROM kanouk_ref_dirty WHERE (source, source_id, stamp) IN (
			SELECT json_extract(value, '$.s'), json_extract(value, '$.id'), json_extract(value, '$.stamp') FROM json_each(?1))`).bind(payload),
	]);
	return { processed: batch.length, remaining: dirty.length > limit };
}

/** Drain until clean or `maxRounds` batches; errors are logged, never thrown. */
export async function drainRefIndexSafely(database, { maxRounds = 5, limit = DRAIN_LIMIT } = {}) {
	try {
		for (let round = 0; round < maxRounds; round += 1) {
			const { remaining } = await drainRefIndex(database, { limit });
			if (!remaining) return;
		}
	} catch (error) {
		console.warn("Reference index drain failed", error instanceof Error ? error.message : error);
	}
}

/** One statement: is any entry dirty, and which media effects match `storageKey`. */
export const MEDIA_ACCESS_QUERY = `
	SELECT
		EXISTS (SELECT 1 FROM kanouk_ref_dirty) AS dirty,
		EXISTS (
			SELECT 1 FROM kanouk_ref_index
			WHERE (kind = 'media:key' AND value = ?1)
				OR (kind = 'media:enc' AND value = ?2)
				OR (kind = 'media:id' AND value = (SELECT id FROM media WHERE storage_key = ?1 LIMIT 1))
		) AS allowed,
		EXISTS (
			SELECT 1 FROM kanouk_ref_index
			WHERE (kind = 'block:key' AND value = ?1)
				OR (kind = 'block:id' AND value = (SELECT id FROM media WHERE storage_key = ?1 LIMIT 1))
		) AS blocked
`;

/**
 * @returns {Promise<"public" | "denied" | "dirty">} "dirty" means the index is
 *   not authoritative right now (or unavailable); use the full check.
 */
export async function mediaAccessFromIndex(database, storageKey) {
	const row = await database
		.prepare(MEDIA_ACCESS_QUERY)
		.bind(storageKey, encodeURIComponent(storageKey))
		.first();
	if (!row || row.dirty !== 0) return "dirty";
	return row.allowed === 1 && row.blocked === 0 ? "public" : "denied";
}

/** True when the index is clean (authoritative). Errors count as not clean. */
export async function refIndexIsClean(database) {
	try {
		const row = await database.prepare("SELECT EXISTS (SELECT 1 FROM kanouk_ref_dirty) AS dirty").bind().first();
		return row?.dirty === 0;
	} catch {
		return false;
	}
}
