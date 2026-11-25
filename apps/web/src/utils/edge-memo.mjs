/**
 * Short-lived read-through cache for site-wide aggregate reads.
 *
 * Route-cached pages render with EmDash's object cache bypassed
 * (`routeCacheFill`), so every cold page used to recount the whole site in D1:
 * sidebar term counts (~4k rows), archive months (~2k rows), the article photo
 * map (~4k rows) and the public-media guard (~22k rows per image). A handful of
 * concurrent cold renders then hit D1's "overloaded" limit. These values may be
 * a few minutes stale without harm, so they are kept in the isolate and in the
 * colo's Cache API for a short TTL. Load errors are never cached.
 */

const CACHE_ORIGIN = "https://yohaku-edge-memo.internal/v1/";
const MEMORY_LIMIT = 500;
const GLOBAL_SCOPE = {};
// Isolate-local entries are scoped to the database binding they were read from,
// so a different binding (tests, preview databases) never sees them.
const memories = new WeakMap();

function memoryFor(scope) {
	let memory = memories.get(scope);
	if (!memory) memories.set(scope, (memory = new Map()));
	return memory;
}

function edgeCache() {
	try {
		return globalThis.caches?.default;
	} catch {
		return undefined;
	}
}

function remember(memory, key, value, expires) {
	if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value);
	memory.set(key, { value, expires });
}

/**
 * @template T
 * @param {string} key
 * @param {number | ((value: T) => number)} ttlSeconds
 * @param {() => Promise<T>} load
 * @param {{ cacheable?: (value: T) => boolean, scope?: object, shared?: boolean }} [options]
 *   `scope`: the database binding the value was read from (isolate-local entries
 *   are kept per scope). `shared: false` keeps the value out of the Cache API.
 * @returns {Promise<T>}
 */
export async function edgeMemo(key, ttlSeconds, load, options = {}) {
	const now = Date.now();
	const memory = memoryFor(options.scope ?? GLOBAL_SCOPE);
	const hit = memory.get(key);
	if (hit && hit.expires > now) return hit.value;
	if (hit) memory.delete(key);

	const cache = options.shared === false ? undefined : edgeCache();
	const request = cache ? new Request(CACHE_ORIGIN + encodeURIComponent(key)) : null;
	if (cache && request) {
		try {
			const cached = await cache.match(request);
			if (cached) {
				const expires = Number(cached.headers.get("X-Yohaku-Expires"));
				const value = await cached.json();
				if (Number.isFinite(expires) && expires > now) {
					remember(memory, key, value, expires);
					return value;
				}
			}
		} catch {
			// A cache failure is a miss.
		}
	}

	const value = await load();
	if (options.cacheable && !options.cacheable(value)) return value;
	const ttl = typeof ttlSeconds === "function" ? ttlSeconds(value) : ttlSeconds;
	if (!(ttl > 0)) return value;
	const expires = now + ttl * 1000;
	remember(memory, key, value, expires);
	if (cache && request) {
		try {
			await cache.put(request, new Response(JSON.stringify(value), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `public, max-age=${Math.ceil(ttl)}`,
					"X-Yohaku-Expires": String(expires),
				},
			}));
		} catch {
			// A cache failure only costs the next request a D1 read.
		}
	}
	return value;
}

/** Test hook: forget isolate-local entries. */
export function clearEdgeMemo(scope = GLOBAL_SCOPE) {
	memories.delete(scope);
}

/** A short stable key for a long input (e.g. a list of media ids). */
export async function digestKey(input) {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
