import { edgeMemo } from "./edge-memo.mjs";

/**
 * Aggregates cached by change stamp (`kanouk_change_gen`, migration
 * kanouk/0002). Triggers replace a stamp whenever a row the aggregate depends
 * on changes, so the cached value can live for hours and still turn over on
 * the first request after an edit. Without the table (migration not applied,
 * or a read error) the value falls back to the short time-based cache.
 */
export const STAMPED_TTL_SECONDS = 6 * 60 * 60;
export const FALLBACK_TTL_SECONDS = 300;

export const CHANGE_GEN_QUERY = "SELECT gen FROM kanouk_change_gen WHERE name = ?1";

/** @param {any} database @param {string} name @returns {Promise<string | null>} */
export async function changeGeneration(database, name) {
	if (!database) return null;
	try {
		const row = await database.prepare(CHANGE_GEN_QUERY).bind(name).first();
		return typeof row?.gen === "string" && row.gen ? row.gen : null;
	} catch {
		return null;
	}
}

/**
 * @template T
 * @param {any} database
 * @param {string} name  the change stamp the value depends on
 * @param {string} key
 * @param {() => Promise<T>} load
 * @param {{ cacheable?: (value: T) => boolean }} [options]
 * @returns {Promise<T>}
 */
export async function stampedMemo(database, name, key, load, options = {}) {
	const gen = await changeGeneration(database, name);
	if (!gen) return edgeMemo(key, FALLBACK_TTL_SECONDS, load, options);
	return edgeMemo(`${key}@${gen}`, STAMPED_TTL_SECONDS, load, options);
}
