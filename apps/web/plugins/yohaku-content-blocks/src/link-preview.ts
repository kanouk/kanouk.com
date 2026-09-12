export interface LinkPreviewMetadata {
	url: string;
	title: string;
	description: string;
	imageUrl: string;
}

export interface LinkPreviewAutoSnapshot extends LinkPreviewMetadata {
	version: 1;
	fetchedAt: string;
}

export interface LinkPreviewCacheReader {
	get<T>(key: string): Promise<T | null>;
}

export interface LinkPreviewCache extends LinkPreviewCacheReader {
	set(key: string, value: unknown): Promise<void>;
}

export type LinkPreviewDnsResolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

export interface LinkPreviewOptions {
	mode?: "fetch" | "cache-only";
	fetch?: typeof globalThis.fetch;
	resolveDns?: LinkPreviewDnsResolver;
	now?: () => number;
	resolveInternal?: (url: string) => Promise<LinkPreviewMetadata | null>;
	/** Test seam; production callers are always capped at eight seconds. */
	timeoutMs?: number;
	/** Skip fresh/negative cache reads. Used only after the public-card lease is held. */
	forceRefresh?: boolean;
}

export interface CachedLinkPreview {
	version: 1;
	expiresAt: number;
	staleUntil: number;
	fetchedAt: string;
	metadata?: LinkPreviewMetadata;
	negativeUntil?: number;
}

export type LinkPreviewCacheState =
	| { state: "fresh" | "stale"; metadata: LinkPreviewMetadata; fetchedAt: string; retryAfterMs?: number }
	| { state: "negative"; retryAfterMs: number }
	| { state: "miss" };

const CACHE_PREFIX = "cache:link-preview:v1:";
const OPTION_PREFIX = "plugin:yohaku-content-blocks:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const LINK_PREVIEW_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
export const MAX_LINK_PREVIEW_URL_LENGTH = 2_048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const OWN_HOSTS = new Set([
	"blog.kanouk.com",
	"blog-staging.kanouk.com",
	"photos.kanouk.com",
	"photos-staging.kanouk.com",
	"kanouk-emdash-staging.kanouk.workers.dev",
	"kanolog.net",
	"www.kanolog.net",
	"nocalog.net",
	"www.nocalog.net",
	"art-quiz.com",
	"www.art-quiz.com",
]);

export function isOwnLinkPreviewHost(hostname: string): boolean {
	return OWN_HOSTS.has(hostname.toLowerCase().replace(/\.+$/, ""));
}

export function safeLinkPreviewImageUrl(value: string, allowOwnHost = false): string {
	if (!value) return "";
	try {
		const image = normalizeUrl(value);
		return !allowOwnHost && isOwnLinkPreviewHost(image.hostname) ? "" : image.href;
	} catch {
		return "";
	}
}
const BLOCKED_HOST_SUFFIXES = [
	".internal",
	".lan",
	".local",
	".localhost",
	".home",
	".test",
	".invalid",
	".example",
	".nip.io",
	".sslip.io",
	".xip.io",
	".lvh.me",
	".localtest.me",
];

export class LinkPreviewError extends Error {
	code: "INVALID_URL" | "SSRF_BLOCKED" | "UPSTREAM_ERROR" | "TOO_LARGE" | "TIMEOUT";

	constructor(
		code: "INVALID_URL" | "SSRF_BLOCKED" | "UPSTREAM_ERROR" | "TOO_LARGE" | "TIMEOUT",
		message: string,
	) {
		super(message);
		this.name = "LinkPreviewError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(input: string): URL {
	const value = input.trim();
	if (!value || value.length > MAX_LINK_PREVIEW_URL_LENGTH || !/^https:\/\//i.test(value)) {
		throw new LinkPreviewError("INVALID_URL", "公開 HTTPS URL を入力してください。");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new LinkPreviewError("INVALID_URL", "URL の形式を確認してください。");
	}
	const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		authority.includes("@") ||
		authority.startsWith("[") ||
		authority.includes(":")
	) {
		throw new LinkPreviewError("INVALID_URL", "認証情報やポートを含まない HTTPS URL を入力してください。");
	}
	const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
	if (!hostname || hostname !== parsed.hostname.toLowerCase() || !hostname.includes(".")) {
		throw new LinkPreviewError("SSRF_BLOCKED", "公開ホストではない URL は取得できません。");
	}
	if (isIpLiteral(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
		throw new LinkPreviewError("SSRF_BLOCKED", "公開ホストではない URL は取得できません。");
	}
	parsed.hash = "";
	return parsed;
}

function parseIpv4(value: string): number[] | null {
	const parts = value.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
	const octets = parts.map(Number);
	return octets.some((part) => part < 0 || part > 255) ? null : octets;
}

function isPublicIpv4(value: string): boolean {
	const octets = parseIpv4(value);
	if (!octets) return false;
	const [a, b, c] = octets;
	return !(
		a === 0 || a === 10 || a === 127 || a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function expandIpv6(value: string): number[] | null {
	let source = value.toLowerCase();
	const zone = source.indexOf("%");
	if (zone >= 0) return null;
	const ipv4Match = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
	let ipv4Groups: string[] = [];
	if (ipv4Match) {
		const octets = parseIpv4(ipv4Match[1]);
		if (!octets) return null;
		ipv4Groups = [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
		source = source.slice(0, -ipv4Match[1].length).replace(/:$/, "");
	}
	if ((source.match(/::/g) ?? []).length > 1) return null;
	const [leftRaw, rightRaw] = source.split("::");
	const left = leftRaw ? leftRaw.split(":") : [];
	const right = rightRaw ? rightRaw.split(":") : [];
	const missing = 8 - left.length - right.length - ipv4Groups.length;
	if ((source.includes("::") && missing < 1) || (!source.includes("::") && missing !== 0)) return null;
	const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right, ...ipv4Groups];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv6(value: string): boolean {
	const groups = expandIpv6(value.replace(/^\[|\]$/g, ""));
	if (!groups) return false;
	const [first, second, _third, _fourth, _fifth, sixth, seventh, eighth] = groups;
	if (groups.every((group) => group === 0) || groups.slice(0, 7).every((group) => group === 0) && eighth === 1) return false;
	if (
		(first & 0xfe00) === 0xfc00 ||
		(first & 0xffc0) === 0xfe80 ||
		(first & 0xffc0) === 0xfec0 ||
		(first & 0xff00) === 0xff00
	) return false;
	// Block special/transition ranges instead of trying to prove that their
	// embedded IPv4 destination is globally reachable.
	if (
		(first === 0x2001 && second < 0x0200) ||
		(first === 0x2001 && second === 0x0db8) ||
		first === 0x2002 ||
		(first === 0x0064 && second === 0xff9b) ||
		(groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff) ||
		groups.slice(0, 6).every((group) => group === 0)
	) return false;
	if (groups.slice(0, 5).every((group) => group === 0) && sixth === 0xffff) {
		return isPublicIpv4(`${seventh >> 8}.${seventh & 255}.${eighth >> 8}.${eighth & 255}`);
	}
	return true;
}

function isIpLiteral(hostname: string): boolean {
	return parseIpv4(hostname) !== null || expandIpv6(hostname.replace(/^\[|\]$/g, "")) !== null;
}

export function isPublicIpAddress(value: string): boolean {
	return value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
}

export function createPublicDnsResolver(fetchImpl: typeof globalThis.fetch = globalThis.fetch): LinkPreviewDnsResolver {
	return async (hostname, signal) => {
		const query = async (type: "A" | "AAAA", answerType: 1 | 28): Promise<string[]> => {
			const params = new URLSearchParams({ name: hostname, type });
			const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?${params}`, {
				headers: { Accept: "application/dns-json" },
				credentials: "omit",
				redirect: "manual",
				signal,
			});
			if (!response.ok) throw new LinkPreviewError("SSRF_BLOCKED", "DNS を検証できませんでした。");
			const body: unknown = await response.json();
			if (!isRecord(body) || typeof body.Status !== "number" || body.Status !== 0) {
				throw new LinkPreviewError("SSRF_BLOCKED", "DNS を検証できませんでした。");
			}
			return Array.isArray(body.Answer)
				? body.Answer.flatMap((answer) => isRecord(answer) && answer.type === answerType && typeof answer.data === "string" ? [answer.data] : [])
				: [];
		};
		const [ipv4, ipv6] = await Promise.all([query("A", 1), query("AAAA", 28)]);
		return [...ipv4, ...ipv6];
	};
}

export const resolvePublicDns = createPublicDnsResolver();

async function validatePublicUrl(url: URL, resolver: LinkPreviewDnsResolver, signal: AbortSignal): Promise<void> {
	const addresses = await resolver(url.hostname, signal);
	if (!addresses.length || addresses.some((address) => !isPublicIpAddress(address))) {
		throw new LinkPreviewError("SSRF_BLOCKED", "公開 IP を確認できない URL は取得できません。");
	}
}

function decodeEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&", apos: "'", gt: ">", hellip: "…", laquo: "«", ldquo: "“", lt: "<",
		mdash: "—", nbsp: " ", ndash: "–", quot: '"', raquo: "»", rdquo: "”", rsquo: "’",
	};
	return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
		const hex = entity[1]?.toLowerCase() === "x";
		const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
		if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) return "�";
		return String.fromCodePoint(codePoint);
	});
}

function cleanText(value: string, maxLength: number): string {
	return decodeEntities(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function attributes(tag: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
		result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return result;
}

export function parseLinkPreviewHtml(html: string, pageUrl: string): LinkPreviewMetadata {
	const values = new Map<string, string>();
	for (const match of html.matchAll(/<meta\b[^>]{0,4096}>/gi)) {
		const attrs = attributes(match[0]);
		const key = (attrs.property || attrs.name || "").toLowerCase();
		if (key && attrs.content && !values.has(key)) values.set(key, attrs.content);
	}
	const titleTag = html.match(/<title\b[^>]*>([\s\S]{0,4096}?)<\/title\s*>/i)?.[1] ?? "";
	const page = new URL(pageUrl);
	const title = cleanText(values.get("og:title") || values.get("twitter:title") || titleTag || page.hostname, 300);
	const description = cleanText(values.get("og:description") || values.get("twitter:description") || values.get("description") || "", 1_000);
	const rawImage = values.get("og:image:secure_url") || values.get("og:image") || values.get("twitter:image") || "";
	let imageUrl = "";
	if (rawImage) {
		try { imageUrl = normalizeUrl(new URL(decodeEntities(rawImage), page).href).href; } catch { imageUrl = ""; }
	}
	return { url: page.href, title, description, imageUrl };
}

async function readHtml(response: Response): Promise<string> {
	const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
	if (!/^text\/html(?:\s*;|$)/.test(contentType) && !/^application\/xhtml\+xml(?:\s*;|$)/.test(contentType)) {
		throw new LinkPreviewError("UPSTREAM_ERROR", "HTML ページではないため情報を取得できません。");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = "";
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			html += decoder.decode();
			break;
		}
		const remaining = MAX_HTML_BYTES - length;
		const inspected = value.byteLength > remaining ? value.subarray(0, remaining) : value;
		length += inspected.byteLength;
		html += decoder.decode(inspected, { stream: true });
		const headEnd = html.search(/<\/head\s*>/i);
		if (headEnd >= 0) {
			await reader.cancel();
			return html.slice(0, headEnd + html.slice(headEnd).indexOf(">") + 1);
		}
		if (value.byteLength > remaining || length >= MAX_HTML_BYTES) {
			await reader.cancel();
			throw new LinkPreviewError("TOO_LARGE", "HTML が 512 KiB の上限を超えています。");
		}
	}
	return html;
}

function validCachedMetadata(value: unknown): value is LinkPreviewMetadata {
	if (!isRecord(value) ||
		typeof value.url !== "string" ||
		typeof value.title !== "string" ||
		typeof value.description !== "string" ||
		typeof value.imageUrl !== "string"
	) return false;
	try {
		normalizeUrl(value.url);
		if (value.imageUrl) normalizeUrl(value.imageUrl);
		return true;
	} catch {
		return false;
	}
}

export async function linkPreviewCacheKey(url: string): Promise<string> {
	const normalized = normalizeUrl(url).href;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
	return `${CACHE_PREFIX}${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function linkPreviewCacheOptionName(url: string): Promise<string> {
	return `${OPTION_PREFIX}${await linkPreviewCacheKey(url)}`;
}

export async function getCachedLinkPreview(
	url: string,
	cache: LinkPreviewCacheReader,
	now: () => number = Date.now,
): Promise<LinkPreviewMetadata | null> {
	const state = await getLinkPreviewCacheState(url, cache, now);
	return state.state === "fresh" ? state.metadata : null;
}

export async function getCachedLinkPreviewIncludingStale(
	url: string,
	cache: LinkPreviewCacheReader,
	now: () => number = Date.now,
): Promise<LinkPreviewMetadata | null> {
	const state = await getLinkPreviewCacheState(url, cache, now);
	if (state.state === "fresh" || state.state === "stale") return state.metadata;
	// Like an editor's saved OGP snapshot, keep the last successful external
	// preview visible during outages/bot rejection. This does not extend the
	// refresh/negative TTLs, and never revives an internal unpublished target.
	const requested = normalizeUrl(url);
	if (isOwnLinkPreviewHost(requested.hostname)) return null;
	const retained = await cache.get<unknown>(await linkPreviewCacheKey(url));
	if (!isRecord(retained) || retained.version !== 1 || !validCachedMetadata(retained.metadata)) return null;
	if (isOwnLinkPreviewHost(new URL(retained.metadata.url).hostname)) return null;
	return { ...retained.metadata, imageUrl: safeLinkPreviewImageUrl(retained.metadata.imageUrl, false) };
}

export async function getLinkPreviewCacheState(
	url: string,
	cache: LinkPreviewCacheReader,
	now: () => number = Date.now,
): Promise<LinkPreviewCacheState> {
	const requested = normalizeUrl(url);
	const record = await cache.get<unknown>(await linkPreviewCacheKey(url));
	if (!isRecord(record) || record.version !== 1 || typeof record.expiresAt !== "number") return { state: "miss" };
	const timestamp = now();
	const fetchedAt = typeof record.fetchedAt === "string"
		? record.fetchedAt
		: new Date(Math.min(record.expiresAt, timestamp)).toISOString();
	const cachedMetadata = validCachedMetadata(record.metadata) &&
		!(isOwnLinkPreviewHost(record.metadata.url ? new URL(record.metadata.url).hostname : "") && !isOwnLinkPreviewHost(requested.hostname))
		? { ...record.metadata, imageUrl: safeLinkPreviewImageUrl(record.metadata.imageUrl, isOwnLinkPreviewHost(requested.hostname)) }
		: null;
	if (cachedMetadata) {
		if (record.expiresAt > timestamp) return { state: "fresh", metadata: cachedMetadata, fetchedAt };
		const staleUntil = typeof record.staleUntil === "number"
			? record.staleUntil
			: record.expiresAt + CACHE_STALE_MS;
		if (staleUntil > timestamp) return {
			state: "stale",
			metadata: cachedMetadata,
			fetchedAt,
			retryAfterMs: typeof record.negativeUntil === "number" && record.negativeUntil > timestamp
				? record.negativeUntil - timestamp
				: undefined,
		};
	}
	if (typeof record.negativeUntil === "number" && record.negativeUntil > timestamp) {
		return { state: "negative", retryAfterMs: record.negativeUntil - timestamp };
	}
	return { state: "miss" };
}

export async function cacheLinkPreviewFailure(
	url: string,
	cache: LinkPreviewCache,
	now: () => number = Date.now,
): Promise<void> {
	const key = await linkPreviewCacheKey(url);
	const timestamp = now();
	const current = await cache.get<unknown>(key);
	const retained = isRecord(current) && current.version === 1 && validCachedMetadata(current.metadata)
		? current.metadata
		: undefined;
	const fetchedAt = isRecord(current) && typeof current.fetchedAt === "string"
		? current.fetchedAt
		: new Date(timestamp).toISOString();
	const expiresAt = isRecord(current) && typeof current.expiresAt === "number" ? current.expiresAt : 0;
	const staleUntil = isRecord(current) && typeof current.staleUntil === "number"
		? current.staleUntil
		: expiresAt + CACHE_STALE_MS;
	await cache.set(key, {
		version: 1,
		expiresAt,
		staleUntil,
		fetchedAt,
		metadata: retained,
		negativeUntil: timestamp + LINK_PREVIEW_NEGATIVE_TTL_MS,
	} satisfies CachedLinkPreview);
}

export interface D1LinkPreviewDatabase {
	prepare(query: string): { bind(...values: unknown[]): {
		first<T>(): Promise<T | null>;
		run?(): Promise<unknown>;
	} };
}

export function createD1LinkPreviewCacheReader(database: D1LinkPreviewDatabase): LinkPreviewCacheReader {
	return {
		async get<T>(key: string): Promise<T | null> {
			const row = await database.prepare("SELECT value FROM options WHERE name = ? LIMIT 1")
				.bind(`${OPTION_PREFIX}${key}`).first<{ value?: unknown }>();
			if (!row || typeof row.value !== "string") return null;
			try { return JSON.parse(row.value) as T; } catch { return null; }
		},
	};
}

export interface LinkPreviewLease {
	acquire(key: string, token: string, expiresAt: number, now: number): Promise<boolean>;
	release(key: string, token: string): Promise<void>;
}

export function createD1LinkPreviewCache(database: D1LinkPreviewDatabase): LinkPreviewCache & LinkPreviewLease {
	const optionName = (key: string) => `${OPTION_PREFIX}${key}`;
	return {
		...createD1LinkPreviewCacheReader(database),
		async set(key, value) {
			const statement = database.prepare(`
				INSERT INTO options (name, value) VALUES (?1, ?2)
				ON CONFLICT(name) DO UPDATE SET value = excluded.value
			`).bind(optionName(key), JSON.stringify(value));
			if (!statement.run) throw new Error("D1 write support is unavailable");
			await statement.run();
		},
		async acquire(key, token, expiresAt, now) {
			const statement = database.prepare(`
				INSERT INTO options (name, value) VALUES (?1, ?2)
				ON CONFLICT(name) DO UPDATE SET value = excluded.value
				WHERE COALESCE(json_extract(options.value, '$.expiresAt'), 0) <= ?3
				RETURNING value
			`).bind(optionName(key), JSON.stringify({ token, expiresAt }), now);
			const row = await statement.first<{ value?: string }>();
			if (!row || typeof row.value !== "string") return false;
			try { return (JSON.parse(row.value) as { token?: unknown }).token === token; } catch { return false; }
		},
		async release(key, token) {
			const statement = database.prepare(`
				DELETE FROM options
				WHERE name = ?1 AND json_extract(value, '$.token') = ?2
			`).bind(optionName(key), token);
			if (!statement.run) throw new Error("D1 write support is unavailable");
			await statement.run();
		},
	};
}

async function fetchExternalPreview(
	url: URL,
	options: Required<Pick<LinkPreviewOptions, "fetch" | "resolveDns">>,
	signal: AbortSignal,
): Promise<LinkPreviewMetadata> {
	let current = url;
	for (let redirects = 0; ; redirects += 1) {
		await validatePublicUrl(current, options.resolveDns, signal);
		const response = await options.fetch(current.href, {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			headers: {
				Accept: "text/html, application/xhtml+xml;q=0.9",
				"User-Agent": "Mozilla/5.0 (compatible; KanologLinkPreview/1.0; +https://blog.kanouk.com/)",
				"Accept-Language": "ja,en;q=0.7",
			},
			signal,
		});
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("Location");
			await response.body?.cancel();
			if (!location || redirects >= MAX_REDIRECTS) throw new LinkPreviewError("UPSTREAM_ERROR", "リダイレクトが多すぎます。");
			current = normalizeUrl(new URL(location, current).href);
			if (isOwnLinkPreviewHost(current.hostname)) {
				throw new LinkPreviewError("SSRF_BLOCKED", "サイト内 URL への外部リダイレクトは取得できません。");
			}
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new LinkPreviewError("UPSTREAM_ERROR", `リンク先が HTTP ${response.status} を返しました。`);
		}
		const metadata = parseLinkPreviewHtml(await readHtml(response), current.href);
		if (metadata.imageUrl) {
			try {
				const image = normalizeUrl(metadata.imageUrl);
				if (isOwnLinkPreviewHost(image.hostname)) throw new LinkPreviewError("SSRF_BLOCKED", "サイト内画像は外部カードから取得できません。");
				await validatePublicUrl(image, options.resolveDns, signal);
			}
			catch { metadata.imageUrl = ""; }
		}
		return metadata;
	}
}

export async function getLinkPreview(
	url: string,
	cache: LinkPreviewCacheReader | LinkPreviewCache,
	options: LinkPreviewOptions = {},
): Promise<LinkPreviewMetadata | null> {
	const normalized = normalizeUrl(url);
	const internal = options.resolveInternal ? await options.resolveInternal(normalized.href) : null;
	if (internal) return internal;
	// Never fall back to potentially stale network OGP for a canonical own-host
	// URL that the current published CMS view did not recognize.
	if (OWN_HOSTS.has(normalized.hostname)) return null;
	const now = options.now ?? Date.now;
	const cacheState = await getLinkPreviewCacheState(normalized.href, cache, now);
	if (!options.forceRefresh) {
		if (cacheState.state === "fresh") return cacheState.metadata;
		if (cacheState.state === "negative") return null;
		if (options.mode === "cache-only") return cacheState.state === "stale" ? cacheState.metadata : null;
	}
	if (options.mode === "cache-only") return cacheState.state === "stale" ? cacheState.metadata : null;
	if (!("set" in cache)) return null;
	const controller = new AbortController();
	const timeoutMs = Math.min(FETCH_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? FETCH_TIMEOUT_MS));
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// DNS is rechecked before each manual redirect. Workers cannot pin the
		// validated address to fetch(), so residual TOCTOU protection relies on
		// Cloudflare's fetch egress boundary (this app has no origin/VPC binding).
		const metadata = await fetchExternalPreview(normalized, {
			fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
			resolveDns: options.resolveDns ?? resolvePublicDns,
		}, controller.signal);
		const storedAt = now();
		const record: CachedLinkPreview = {
			version: 1,
			expiresAt: storedAt + CACHE_TTL_MS,
			staleUntil: storedAt + CACHE_TTL_MS + CACHE_STALE_MS,
			fetchedAt: new Date(storedAt).toISOString(),
			metadata,
		};
		await cache.set(await linkPreviewCacheKey(normalized.href), record);
		return metadata;
	} catch (error) {
		if (controller.signal.aborted) throw new LinkPreviewError("TIMEOUT", "リンク先の取得がタイムアウトしました。");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
