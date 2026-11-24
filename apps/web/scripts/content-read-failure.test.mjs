import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentUnavailable, redirectNotFound } from "../src/utils/route-guards.ts";

const fakeAstro = () => {
	const cacheCalls = [];
	return {
		cacheCalls,
		url: new URL("https://blog.kanouk.com/posts/01M1CHAY4DFCEE6EFTHNJSJPEH"),
		cache: { enabled: true, set: (value) => cacheCalls.push(value) },
		redirect: (to) => new Response(null, { status: 302, headers: { Location: to } }),
	};
};

test("a failed content read answers an uncached 503, not a cached redirect to /404", () => {
	const astro = fakeAstro();
	const originalError = console.error;
	console.error = () => {};
	try {
		const response = contentUnavailable(astro, new Error("D1_ERROR: network connection lost"));
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(response.headers.get("Retry-After"), "5");
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(astro.cacheCalls, [false]);
});

test("a genuinely missing entry still redirects to /404 but stays out of the route cache", () => {
	const astro = fakeAstro();
	const response = redirectNotFound(astro);
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("Location"), "/404");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(astro.cacheCalls, [false]);
});

test("cached content routes check the read error before treating a miss as not found", () => {
	for (const route of [
		"src/pages/posts/[slug].astro",
		"src/pages/pages/[slug].astro",
		"src/pages/category/[slug].astro",
		"src/pages/tag/[slug].astro",
		"src/pages/archives/[year]/[month].astro",
	]) {
		const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /Astro\.redirect\("\/404"\)/, `${route} must use redirectNotFound`);
		assert.match(source, /contentUnavailable\(Astro, \w+Error\)/, `${route} must answer 503 on a read error`);
	}
});
