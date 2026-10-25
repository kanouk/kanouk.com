import { getEmDashCollection, getTaxonomyTerms } from "emdash";
import { getPostArchiveMonths } from "./post-archives";

/**
 * Queries shared by the blog layout and sidebar, started once per request.
 *
 * Astro renders a page's frontmatter, then the layout's, then each component's,
 * one after another; every `await` on a D1 round trip (about 60 ms from the
 * Worker) adds to a cold page's time to first byte. A page calls
 * `startSharedBlogQueries` first thing so these run alongside its own queries,
 * and the layout / components await the same promises later. A page that does
 * not call it still works: the first component to ask starts the query.
 */
export interface SharedBlogQueries {
	footerPages: ReturnType<typeof getEmDashCollection<"pages">>;
	categoryTerms: ReturnType<typeof getTaxonomyTerms>;
	tagTerms: ReturnType<typeof getTaxonomyTerms>;
	archiveMonths: ReturnType<typeof getPostArchiveMonths>;
}

type SharedQueryName = keyof SharedBlogQueries;
type SharedQueryStore = Partial<SharedBlogQueries>;

const STORE_KEY = "__yohakuSharedBlogQueries";

function store(locals: object): SharedQueryStore {
	const holder = locals as Record<string, unknown>;
	return (holder[STORE_KEY] ??= {}) as SharedQueryStore;
}

const starters: { [K in SharedQueryName]: () => SharedBlogQueries[K] } = {
	footerPages: () => getEmDashCollection("pages", { status: "published", orderBy: { published_at: "desc" }, limit: 8 }),
	categoryTerms: () => getTaxonomyTerms("category", { includeCounts: true }),
	tagTerms: () => getTaxonomyTerms("tag", { includeCounts: true }),
	archiveMonths: () => getPostArchiveMonths(24),
};

/** The shared promise for one query, started now if nothing started it yet. */
export function sharedBlogQuery<K extends SharedQueryName>(locals: object, name: K): SharedBlogQueries[K] {
	const memo = store(locals);
	if (!memo[name]) {
		const promise = starters[name]() as SharedBlogQueries[K];
		// A page may finish without awaiting this (a redirect, an error); the
		// component that awaits it still sees the rejection.
		void promise.catch(() => undefined);
		memo[name] = promise;
	}
	return memo[name] as SharedBlogQueries[K];
}

/** Start every shared query at the top of a blog page's frontmatter. */
export function startSharedBlogQueries(locals: object, names: SharedQueryName[] = ["footerPages", "categoryTerms", "tagTerms", "archiveMonths"]): void {
	for (const name of names) sharedBlogQuery(locals, name);
}
