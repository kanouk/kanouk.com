import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
	readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("public HTML routes have an edge cache with private-state bypasses", async () => {
	const [config, middleware] = await Promise.all([
		read("astro.config.mjs"),
		read("src/middleware.ts"),
	]);
	assert.match(config, /cacheCloudflare\(\)/);
	assert.match(config, /"\/posts\/\[slug\]": \{ maxAge: 300, swr: 86400 \}/);
	assert.match(config, /"\/albums\/\[slug\]": \{ maxAge: 300, swr: 86400 \}/);
	assert.match(middleware, /context\.cache\.set\(false\)/);
	assert.match(middleware, /astro-session/);
	assert.match(middleware, /set-cookie/);
	assert.match(middleware, /appendVaryHeader\(routedResponse, "Host"\)/);
	assert.match(middleware, /const crossHostRedirect/);
	assert.match(middleware, /crossHostRedirect[\s\S]*context\.cache\.set\(false\)[\s\S]*Cache-Control", "private, no-store"/);
	assert.match(middleware, /return crossHostRedirect\(`https:\/\/photos\.kanouk\.com/);
});

test("public pages prefer local Noto Sans JP without route-blocking font bundles", async () => {
	const [config, head, theme] = await Promise.all([
		read("astro.config.mjs"),
		read("src/components/YohakuHead.astro"),
		read("src/styles/theme.css"),
	]);
	assert.doesNotMatch(config, /fontProviders|\n\s*fonts:/);
	assert.doesNotMatch(head, /astro:assets|<Font/);
	assert.match(head, /Reserve the responsive site chrome/);
	assert.match(theme, /--font-body: "Noto Sans JP"/);
});

test("analytics waits until the critical page load has completed", async () => {
	const head = await read("src/components/YohakuHead.astro");
	assert.doesNotMatch(head, /<script[^>]+src=\{`https:\/\/www\.googletagmanager\.com/);
	assert.match(head, /window\.addEventListener\("load", loadAnalyticsWhenIdle/);
	assert.match(head, /requestIdleCallback\(loadAnalytics/);
});

test("content images expose responsive AVIF and WebP variants", async () => {
	const [worker, image, gallery, post] = await Promise.all([
		read("src/worker.ts"),
		read("src/components/YohakuImage.astro"),
		read("plugins/yohaku-content-blocks/src/astro/Gallery.astro"),
		read("src/pages/posts/[slug].astro"),
	]);
	for (const width of [320, 480, 768, 1200, 1600]) {
		assert.match(worker, new RegExp(`\\b${width}\\b`));
	}
	assert.match(worker, /"avif" \| "webp"/);
	assert.match(worker, /EXTERNAL_PREVIEW_PREFIX/);
	assert.match(worker, /isTrustedLegacyImageUrl/);
	assert.match(image, /<source type="image\/avif"/);
	assert.match(image, /srcset=\{webpSrcset\}/);
	assert.match(image, /sizes=\{responsiveSizes\}/);
	assert.match(image, /fetchpriority=\{priority \? "high"/);
	assert.match(image, /_yohaku\/media\/external-v1/);
	assert.match(gallery, /<YohakuImage/);
	assert.match(gallery, /priority=\{_yohakuPriority && index === 0\}/);
	assert.match(gallery, /\.yohaku-gallery :global\(img\)/);
	assert.doesNotMatch(gallery, /^\s*:global\(img\)\s*\{/m);
	assert.match(post, /new MediaRepository\(await getDb\(\)\)\.findById/);
	assert.match(post, /\.\.\.firstImageDimensions, _yohakuPriority: true/);
});

test("photo detail navigation is computed in one bounded database query", async () => {
	const [page, album, navigation] = await Promise.all([
		read("src/pages/p/[slug].astro"),
		read("src/pages/albums/[slug].astro"),
		read("src/utils/photo-navigation.ts"),
	]);
	assert.doesNotMatch(page, /albumPhotosCursor|albumPhotos\.push/);
	assert.match(page, /where: \{ id: photo\.data\.album \}/);
	assert.match(album, /sortPhotosChronologically\(photos\)/);
	assert.match(album, /chronologicalPhotos\.map/);
	assert.match(navigation, /ROW_NUMBER\(\) OVER/);
	assert.match(navigation, /LAG\(id\) OVER/);
	assert.match(navigation, /LEAD\(id\) OVER/);
	assert.match(navigation, /unixepoch\(captured_at\)/);
	assert.match(navigation, /captured_epoch IS NULL ASC, captured_epoch ASC, position ASC, id ASC/);
});

test("photo detail controls and metadata stay inside the viewer", async () => {
	const [page, theme] = await Promise.all([
		read("src/pages/p/[slug].astro"),
		read("src/styles/theme.css"),
	]);
	assert.match(page, /class="photo-action-rail"/);
	assert.match(page, /data-photo-info-panel/);
	assert.match(page, /data-src=\{mapEmbedUrl\}/);
	assert.match(page, /infoMap\.setAttribute\("src", infoMap\.dataset\.src\)/);
	assert.doesNotMatch(page, /class="photo-tools"/);
	assert.doesNotMatch(page, /class="photo-navigation"/);
	assert.doesNotMatch(page, /<section class="(?:exif|location)"/);
	assert.match(theme, /\.photo-media-frame \{[^}]*border: 0;[^}]*outline: 0;[^}]*box-shadow: none;/);
	assert.match(theme, /\.photo-info-panel\[hidden\] \{ display: none; \}/);
});

test("the album map defers Leaflet until the map is opened", async () => {
	const albumMap = await read("src/components/AlbumMap.astro");
	assert.doesNotMatch(albumMap, /^\s*import L from "leaflet";/m);
	assert.match(albumMap, /await import\("leaflet"\)/);
});
