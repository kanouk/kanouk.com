import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import {
	pickRelatedPosts,
	relatedCandidateLimit,
	relatedTagSlugs,
	termSlugs,
	RELATED_POST_LIMIT,
} from "../src/utils/related-posts.mjs";

const post = (id, publishedAt, status = "published") => ({
	id: `slug-${id}`,
	data: { id, publishedAt: publishedAt ? new Date(publishedAt) : null, status },
});
const ids = (entries) => entries.map((entry) => entry.data.id);
const current = post("current", "2024-05-01T00:00:00Z");

describe("pickRelatedPosts", () => {
	test("prefers shared-tag posts, then same category, then newest", () => {
		const picked = pickRelatedPosts({
			current,
			tiers: [
				[post("tag-a", "2023-01-01T00:00:00Z")],
				[post("cat-a", "2022-01-01T00:00:00Z")],
				[post("new-a", "2024-06-01T00:00:00Z"), post("new-b", "2024-05-30T00:00:00Z")],
			],
		});
		assert.deepEqual(ids(picked), ["tag-a", "cat-a", "new-a"]);
	});

	test("never returns the current post, matched by database id or slug", () => {
		const sameSlug = { id: current.id, data: { id: "other-id", publishedAt: new Date("2024-06-01"), status: "published" } };
		const picked = pickRelatedPosts({
			current,
			tiers: [[post("current", "2024-05-01T00:00:00Z"), sameSlug, post("tag-a", "2024-01-01T00:00:00Z")]],
		});
		assert.deepEqual(ids(picked), ["tag-a"]);
	});

	test("drops duplicates across tiers and keeps the higher tier", () => {
		const shared = post("both", "2021-01-01T00:00:00Z");
		const picked = pickRelatedPosts({
			current,
			tiers: [[shared], [post("both", "2021-01-01T00:00:00Z"), post("cat-a", "2020-01-01T00:00:00Z")], [post("both", "2021-01-01T00:00:00Z"), post("new-a", "2024-06-01T00:00:00Z")]],
		});
		assert.deepEqual(ids(picked), ["both", "cat-a", "new-a"]);
	});

	test("orders newest first within a tier without mixing tiers", () => {
		const picked = pickRelatedPosts({
			current,
			tiers: [
				[post("tag-old", "2020-01-01T00:00:00Z"), post("tag-new", "2023-01-01T00:00:00Z")],
				[post("cat-newest", "2024-04-01T00:00:00Z")],
			],
		});
		assert.deepEqual(ids(picked), ["tag-new", "tag-old", "cat-newest"]);
	});

	test("skips posts that are not published", () => {
		const picked = pickRelatedPosts({
			current,
			tiers: [[post("draft", "2024-01-01T00:00:00Z", "draft"), post("tag-a", "2023-01-01T00:00:00Z")]],
		});
		assert.deepEqual(ids(picked), ["tag-a"]);
	});

	test("returns at most three and stops once full", () => {
		const tagTier = ["a", "b", "c", "d"].map((id, index) => post(id, `2023-0${index + 1}-01T00:00:00Z`));
		const picked = pickRelatedPosts({ current, tiers: [tagTier, [post("cat-a", "2024-01-01T00:00:00Z")]] });
		assert.equal(picked.length, RELATED_POST_LIMIT);
		assert.deepEqual(ids(picked), ["d", "c", "b"]);
	});

	test("posts without tags fall back to category, then newest", () => {
		const picked = pickRelatedPosts({
			current,
			tiers: [[], [post("cat-a", "2022-01-01T00:00:00Z")], [current, post("new-a", "2024-06-01T00:00:00Z"), post("new-b", "2024-05-02T00:00:00Z")]],
		});
		assert.deepEqual(ids(picked), ["cat-a", "new-a", "new-b"]);
	});

	test("tolerates missing tiers and posts without a published date", () => {
		const picked = pickRelatedPosts({
			current,
			tiers: [undefined, [post("undated", null), post("dated", "2020-01-01T00:00:00Z")]],
		});
		assert.deepEqual(ids(picked), ["dated", "undated"]);
	});

	test("the candidate limit always leaves room for three after exclusions", () => {
		const limit = relatedCandidateLimit();
		assert.equal(limit, RELATED_POST_LIMIT + 1);
		// Worst case: every tier returns the current post and the posts already picked first.
		const tagTier = [current, post("a", "2024-04-03"), post("b", "2024-04-02"), post("c", "2024-04-01")].slice(0, limit);
		const categoryTier = [current, post("a", "2024-04-03"), post("x", "2023-01-01"), post("y", "2022-01-01")].slice(0, limit);
		assert.deepEqual(ids(pickRelatedPosts({ current, tiers: [tagTier.slice(0, 2), categoryTier] })), ["a", "x", "y"]);
	});
});

describe("related tag and category slugs", () => {
	test("hidden tags never count as shared", () => {
		assert.deepEqual(
			relatedTagSlugs([
				{ slug: "travel", label: "旅行・出張" },
				{ slug: "hidden", label: "一覧非表示" },
				{ slug: encodeURIComponent("一覧非表示"), label: "x" },
			]),
			["travel"],
		);
		assert.deepEqual(relatedTagSlugs([{ slug: "hidden", label: "一覧非表示" }]), []);
		assert.deepEqual(relatedTagSlugs(undefined), []);
	});

	test("term slugs are unique and non-empty", () => {
		assert.deepEqual(termSlugs([{ slug: "a" }, { slug: "a" }, { slug: "" }, { slug: "b" }]), ["a", "b"]);
	});
});

test("post page ranks 「続けて読む」 by tag, then category, then newest, with hidden tags removed", async () => {
	const page = await readFile(new URL("../src/pages/posts/[slug].astro", import.meta.url), "utf8");
	assert.match(page, /<h2 class="more-title"[^>]*>続けて読む<\/h2>/);
	// It follows the article in the main column (before the sidebar), as list cards.
	assert.ok(page.indexOf('class="more-posts"') < page.indexOf('class="article-sidebar"'));
	assert.match(page, /class="more-posts"[\s\S]*variant="list"/);
	assert.match(page, /tiers: \[relatedByTag, relatedByCategory, recentPostsResult\.entries\]/);
	assert.match(page, /where: \{ tag: slugs \}/);
	assert.match(page, /where: \{ category: slugs \}/);
	assert.match(page, /const tags: typeof allTags = visibleTags\(allTags\)/);
	assert.match(page, /= visibleTags\(otherTagsByEntry\.get\(p\.data\.id\)/);
	// The related lookups run inside the one parallel sidebar batch, each with its cache hint.
	assert.match(page, /const sidebarDataPromise = Promise\.all\(\[[\s\S]*relatedByTagPromise,\s*relatedByCategoryPromise,\s*\]\)/);
	assert.equal(page.match(/Astro\.cache\.set\(result\.cacheHint\)/g)?.length, 4);
});
