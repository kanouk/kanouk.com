import {
	cacheLinkPreviewFailure,
	getLinkPreview,
	LinkPreviewError,
	getLinkPreviewCacheState,
	isOwnLinkPreviewHost,
	linkPreviewCacheKey,
	type D1LinkPreviewDatabase,
	type LinkPreviewAutoSnapshot,
	type LinkPreviewCache,
	type LinkPreviewDnsResolver,
	type LinkPreviewLease,
	type LinkPreviewMetadata,
} from "./link-preview.ts";

export type PublicLinkPreviewCollection = "posts" | "pages";

export interface PublishedLinkCard {
	collection: PublicLinkPreviewCollection;
	entryId: string;
	blockKey: string;
	url: string;
}

export type PublicLinkPreviewResult =
	| {
		state: "fresh" | "refreshed" | "stale";
		metadata: LinkPreviewAutoSnapshot;
		authoritative: boolean;
		retryAfterMs?: number;
	}
	| {
		state: "pending" | "negative";
		authoritative: boolean;
		retryAfterMs?: number;
	};

export interface PublicLinkPreviewOptions {
	origin: string;
	now?: () => number;
	fetch?: typeof globalThis.fetch;
	resolveDns?: LinkPreviewDnsResolver;
	resolveInternal: (url: string) => Promise<LinkPreviewMetadata | null>;
	coordinator?: LinkPreviewCoordinator;
}

export interface PublicLinkPreviewRequest {
	collection: PublicLinkPreviewCollection;
	entryId: string;
	blockKey: string;
}

export interface LinkPreviewCoordinator {
	tryRun<T>(task: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

const LEASE_TTL_MS = 12_000;
const PENDING_RETRY_MS = 1_500;

export function createLinkPreviewCoordinator(limit = 4): LinkPreviewCoordinator {
	let active = 0;
	return {
		async tryRun(task) {
			if (active >= Math.max(1, limit)) return { acquired: false };
			active += 1;
			try {
				return { acquired: true, value: await task() };
			} finally {
				active -= 1;
			}
		},
	};
}

const sharedCoordinator = createLinkPreviewCoordinator(4);

export function parsePublicLinkPreviewRequest(url: URL): PublicLinkPreviewRequest | null {
	const allowed = new Set(["collection", "entryId", "blockKey"]);
	if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
	const unique = (key: string) => {
		const values = url.searchParams.getAll(key);
		return values.length === 1 ? values[0].trim() : "";
	};
	const collection = unique("collection");
	const entryId = unique("entryId");
	const blockKey = unique("blockKey");
	if (
		(collection !== "posts" && collection !== "pages") ||
		!entryId || entryId.length > 256 ||
		!blockKey || blockKey.length > 256
	) return null;
	return { collection, entryId, blockKey };
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function recognizedCard(block: unknown, blockKey: string): string {
	const candidate = record(block);
	if (!candidate || candidate._key !== blockKey) return "";
	const type = text(candidate._type);
	if (type === "yohaku.linkCard") return text(candidate.id) || text(candidate.url);
	if (type === "yohaku.embed" && candidate.display === "link-card") return text(candidate.id);
	return "";
}

export async function findPublishedLinkCard(
	database: D1LinkPreviewDatabase,
	collection: PublicLinkPreviewCollection,
	entryId: string,
	blockKey: string,
): Promise<PublishedLinkCard | null> {
	const row = await database.prepare(`
		SELECT live.data
		FROM ec_${collection} AS entry
		JOIN revisions AS live ON live.id = entry.live_revision_id
		WHERE entry.status = 'published' AND entry.deleted_at IS NULL
			AND (entry.id = ?1 OR entry.slug = ?1)
		LIMIT 1
	`).bind(entryId).first<{ data?: unknown }>();
	if (!row || typeof row.data !== "string") return null;
	let data: Record<string, unknown> | null = null;
	try { data = record(JSON.parse(row.data)); } catch { return null; }
	if (!data || !Array.isArray(data.content)) return null;
	const matches = data.content.flatMap((block) => {
		const url = recognizedCard(block, blockKey);
		return url ? [url] : [];
	});
	if (matches.length !== 1) return null;
	return { collection, entryId, blockKey, url: matches[0] };
}

function canonicalTarget(candidate: string, origin: string): URL | null {
	try {
		const base = new URL(origin);
		const target = new URL(candidate, base);
		if (target.protocol !== "https:" || target.username || target.password) return null;
		target.hash = "";
		return target;
	} catch {
		return null;
	}
}

function snapshot(metadata: LinkPreviewMetadata, fetchedAt: string, targetUrl: string): LinkPreviewAutoSnapshot {
	return { version: 1, ...metadata, url: targetUrl, fetchedAt };
}

export async function resolvePublicLinkPreview(
	card: PublishedLinkCard,
	cache: LinkPreviewCache & LinkPreviewLease,
	options: PublicLinkPreviewOptions,
): Promise<PublicLinkPreviewResult> {
	const now = options.now ?? Date.now;
	const target = canonicalTarget(card.url, options.origin);
	if (!target) return { state: "negative", authoritative: true };

	const ownTarget = isOwnLinkPreviewHost(target.hostname);
	let internal: LinkPreviewMetadata | null = null;
	try {
		internal = await options.resolveInternal(target.href);
	} catch {
		if (ownTarget) return { state: "negative", authoritative: true };
	}
	if (internal) {
		return {
			state: "fresh",
			metadata: snapshot(internal, new Date(now()).toISOString(), target.href),
			authoritative: true,
		};
	}
	if (ownTarget) {
		// Current published CMS state is authoritative for own-host links. Never
		// revive an unpublished target from an old OGP or editor snapshot.
		return { state: "negative", authoritative: true };
	}

	const prior = await getLinkPreviewCacheState(target.href, cache, now);
	if (prior.state === "fresh") {
		return {
			state: "fresh",
			metadata: snapshot(prior.metadata, prior.fetchedAt, target.href),
			authoritative: false,
		};
	}
	if (prior.state === "negative") {
		return { state: "negative", authoritative: false, retryAfterMs: prior.retryAfterMs };
	}
	if (prior.state === "stale" && prior.retryAfterMs) {
		return {
			state: "stale",
			metadata: snapshot(prior.metadata, prior.fetchedAt, target.href),
			authoritative: false,
			retryAfterMs: prior.retryAfterMs,
		};
	}

	const coordinator = options.coordinator ?? sharedCoordinator;
	const coordinated = await coordinator.tryRun(async (): Promise<PublicLinkPreviewResult> => {
		const cacheKey = await linkPreviewCacheKey(target.href);
		const leaseKey = `lease:${cacheKey}`;
		const token = crypto.randomUUID();
		const startedAt = now();
		if (!await cache.acquire(leaseKey, token, startedAt + LEASE_TTL_MS, startedAt)) {
			return prior.state === "stale"
				? { state: "stale", metadata: snapshot(prior.metadata, prior.fetchedAt, target.href), authoritative: false, retryAfterMs: PENDING_RETRY_MS }
				: { state: "pending", authoritative: false, retryAfterMs: PENDING_RETRY_MS };
		}
		try {
			const metadata = await getLinkPreview(target.href, cache, {
				fetch: options.fetch,
				resolveDns: options.resolveDns,
				now,
				forceRefresh: true,
			});
			if (!metadata) throw new Error("No public metadata");
			const current = await getLinkPreviewCacheState(target.href, cache, now);
			const fetchedAt = current.state === "fresh" ? current.fetchedAt : new Date(now()).toISOString();
			return { state: "refreshed", metadata: snapshot(metadata, fetchedAt, target.href), authoritative: false };
		} catch (error) {
			// No article IDs, paths or query strings in upstream diagnostics.
			console.warn("Link preview failed", target.hostname,
				error instanceof LinkPreviewError ? `${error.code}: ${error.message}` : "unexpected upstream failure");
			await cacheLinkPreviewFailure(target.href, cache, now);
			return prior.state === "stale"
				? { state: "stale", metadata: snapshot(prior.metadata, prior.fetchedAt, target.href), authoritative: false, retryAfterMs: PENDING_RETRY_MS }
				: { state: "negative", authoritative: false, retryAfterMs: 5 * 60 * 1000 };
		} finally {
			await cache.release(leaseKey, token).catch(() => {});
		}
	});

	if (coordinated.acquired) return coordinated.value;
	return prior.state === "stale"
		? { state: "stale", metadata: snapshot(prior.metadata, prior.fetchedAt, target.href), authoritative: false, retryAfterMs: PENDING_RETRY_MS }
		: { state: "pending", authoritative: false, retryAfterMs: PENDING_RETRY_MS };
}
