import { edgeMemo } from "./edge-memo.mjs";

// Article-independent post lists (newest posts, posts with a given tag or
// category). Every article sharing the same terms asks EmDash the same
// question, and each answer costs D1 hundreds to thousands of rows (the
// taxonomy join is sorted by date across every tagged post). Keep each answer
// in the isolate for a few minutes, like the sidebar counts, and let concurrent
// cold renders share one in-flight read. Results hold Dates and full entries,
// so they stay in memory instead of the Cache API. Errors are never kept.
export const POST_LIST_TTL_SECONDS = 300;
const inFlight = new Map();

/**
 * @template {{ error?: unknown }} T
 * @param {string} key
 * @param {() => Promise<T>} load
 * @returns {Promise<T>}
 */
export function sharedPostList(key, load) {
	const pending = inFlight.get(key);
	if (pending) return pending;
	const promise = edgeMemo(`post-list:${key}`, POST_LIST_TTL_SECONDS, load, {
		cacheable: (value) => !value?.error,
		shared: false,
	}).finally(() => inFlight.delete(key));
	inFlight.set(key, promise);
	return promise;
}

/** Memo key for a term filter: the order of slugs does not change the answer. */
export function termListKey(taxonomy, slugs, limit) {
	return `${taxonomy}:${[...slugs].sort().join(",")}:${limit}`;
}
