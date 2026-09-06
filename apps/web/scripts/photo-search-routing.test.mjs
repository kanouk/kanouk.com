import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { findRouteToRewrite } from "../node_modules/astro/dist/core/routing/rewrite.js";

// Execute the real middleware with only Astro's registration wrapper replaced.
const source = (await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8"))
	.replace('import { defineMiddleware } from "astro:middleware";', 'const defineMiddleware = (handler) => handler;');
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

async function route(input) {
	const url = new URL(input);
	let rewritten;
	const cache = [];
	const request = new Request(url);
	const response = await onRequest({
		url, request,
		cookies: { get: () => undefined },
		cache: { set: (value) => cache.push(value) },
		redirect: (target, status) => new Response(null, { status, headers: { Location: target } }),
		rewrite: async (payload) => {
			// Use Astro's actual target resolution, not a mock that preserves queries.
			rewritten = findRouteToRewrite({
				payload, request, routes: [], trailingSlash: "ignore",
				buildFormat: "directory", base: "/", outDir: new URL("file:///tmp/astro-test/"),
			}).newUrl;
			return new Response("search page");
		},
	}, async () => new Response("next"));
	return { rewritten, cache, response };
}

for (const host of ["photos.kanouk.com", "photos-staging.kanouk.com"]) {
	for (const query of ["京都", "京都 & 本", "", "? # / +"]) {
		test(`${host}: photo search retains ${JSON.stringify(query)} and bypasses shared cache`, async () => {
			const params = new URLSearchParams({ q: query, page: "2" });
			const { rewritten, cache, response } = await route(`https://${host}/search?${params}`);
			assert.equal(rewritten.pathname, "/photo-search");
			assert.equal(rewritten.hostname, host);
			assert.equal(rewritten.searchParams.get("q"), query);
			assert.equal(rewritten.searchParams.get("page"), "2");
			assert.ok(cache.includes(false));
			assert.equal(response.headers.get("Cache-Control"), "private, no-store");
			assert.equal(response.headers.get("Vary"), "Host");
		});
	}
}

test("blog search is not rewritten", async () => {
	const { rewritten, response } = await route("https://blog.kanouk.com/search?q=京都");
	assert.equal(rewritten, undefined);
	assert.equal(await response.text(), "next");
});

test("blog photo-search redirect retains the query and is not cached", async () => {
	const { rewritten, response, cache } = await route("https://blog.kanouk.com/photo-search?q=京都");
	assert.equal(rewritten, undefined);
	assert.equal(response.status, 308);
	assert.equal(new URL(response.headers.get("Location")).searchParams.get("q"), "京都");
	assert.ok(cache.includes(false));
});
