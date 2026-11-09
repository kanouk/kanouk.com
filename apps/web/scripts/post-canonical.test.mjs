import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicPageContext, generateBaseSeoContributions, resolvePageMetadata } from "emdash/page";
import { postCanonicalMetadata } from "../plugins/yohaku-content-blocks/src/post-canonical.mjs";

const id = "01M1CJ679Q7GJQGCY6BGWAWGD0";
const canonical = `https://blog.kanouk.com/posts/${id}`;
const storedSeoPage = () => createPublicPageContext({
	url: canonical,
	kind: "content",
	pageType: "article",
	content: { collection: "posts", id, slug: "old-japanese-slug" },
	canonical: "https://blog.kanouk.com/posts/old-japanese-slug",
	title: "Original title",
	description: "Original description",
	image: "https://blog.kanouk.com/original.jpg",
	seo: { ogTitle: "Editor title", robots: "noindex, follow" },
	articleMeta: { publishedTime: "2005-01-01T00:00:00Z", author: "Original author" },
});

test("plugin metadata beats a stored legacy canonical in the real EmDash resolver", () => {
	const page = storedSeoPage();
	const resolved = resolvePageMetadata([...postCanonicalMetadata(page), ...generateBaseSeoContributions(page)]);
	assert.deepEqual(resolved.links.filter((x) => x.rel === "canonical"), [{ rel: "canonical", href: canonical }]);
	assert.deepEqual(resolved.properties.filter((x) => x.property === "og:url"), [{ property: "og:url", content: canonical }]);
	assert.equal(resolved.jsonld.length, 1);
	const graph = JSON.parse(resolved.jsonld[0].json);
	assert.equal(graph.url, canonical);
	assert.equal(graph.mainEntityOfPage["@id"], canonical);
	assert.equal(graph.headline, "Editor title");
	assert.equal(graph.datePublished, "2005-01-01T00:00:00Z");
	assert.equal(graph.author.name, "Original author");
	assert.equal(graph.image, page.image);
	assert.equal(resolved.meta.find((x) => x.name === "robots").content, "noindex, follow");
	assert.equal(page.canonical, "https://blog.kanouk.com/posts/old-japanese-slug");
});

test("pages, photos, custom surfaces and invalid IDs retain their own metadata", () => {
	for (const content of [{ collection: "pages", id }, { collection: "photos", id }, { collection: "posts", id: "../unexpected" }]) assert.equal(postCanonicalMetadata({ ...storedSeoPage(), content }), null);
	assert.equal(postCanonicalMetadata({ ...storedSeoPage(), pageType: "website" }), null);
	assert.equal(postCanonicalMetadata({ ...storedSeoPage(), content: undefined, kind: "custom" }), null);
});
