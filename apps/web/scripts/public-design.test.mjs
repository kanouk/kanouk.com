import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
	readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("the home page stays list-first and includes real post excerpts", async () => {
	const [home, card] = await Promise.all([
		read("src/pages/index.astro"),
		read("src/components/PostCard.astro"),
	]);
	assert.match(home, /class="home-posts"/);
	assert.match(home, /getPostExcerpt\(post\.data\.excerpt, post\.data\.content, 180\)/);
	assert.match(home, /variant="list"/);
	assert.doesNotMatch(home, /featured-section|featured-grid/);
	assert.match(card, /class="card-meta"[\s\S]*class="card-title"[\s\S]*class="card-excerpt"/);
	assert.doesNotMatch(card, /class="card-categories"/);
});

test("profile identity, article hierarchy, and media styles retain distinct contracts", async () => {
	const [profile, image, theme] = await Promise.all([
		read("src/components/ProfileCard.astro"),
		read("src/components/YohakuPortableImage.astro"),
		read("src/styles/theme.css"),
	]);
	assert.match(profile, /profile-card__identity[\s\S]*<h2>カノ<\/h2>[\s\S]*profile-card__type">INFP/);
	assert.match(theme, /\.profile-card__copy \{[\s\S]*border-top: 1px solid var\(--rule\);[\s\S]*text-align: left;/);
	assert.match(theme, /\.article-content > h2,[\s\S]*box-shadow: inset 3px 0 0 var\(--accent\);/);
	assert.match(theme, /\.article-content > h3,[\s\S]*border-bottom: 1px solid var\(--rule\);/);
	assert.match(theme, /\.article-content > h4,[\s\S]*text-decoration: underline;[\s\S]*text-decoration-thickness: 2px;/);
	assert.match(theme, /\.article-content > h4::before,[\s\S]*content: none;/);
	assert.match(theme, /--image-display-width, 30rem/);
	assert.match(image, /node\.displayWidth \? `--image-display-width:\$\{node\.displayWidth\}px`/);
	assert.match(image, /"photo-frame" \| "border" \| "shadow" \| "none"/);
	for (const style of ["photo-frame", "border", "shadow", "none"]) {
		assert.match(theme, new RegExp(`\\.yohaku-portable-image\\.style-${style}`));
	}
});

test("album header keeps the article link short and the photos close", async () => {
	const album = await read("src/pages/albums/[slug].astro");
	assert.match(album, /<span>ブログ記事を読む\{/);
	assert.doesNotMatch(album, /album-head__action-title|album-related-posts/);
	assert.match(album, /aria-controls=\{mapPanelId\}/);
	assert.match(album, /displayTitle && !looksLikeSourceFilename\(displayTitle\)/, "file-name captions stay out of the grid");
	assert.equal(album.match(/<nav class="album-pagination"/g)?.length, 1, "pagination only below the photos");
});

test("album and photo patterns have stable responsive defaults", async () => {
	const theme = await read("src/styles/theme.css");
	assert.match(theme, /\.album-feature-card \{/);
	assert.match(theme, /\.album-head \{/);
	assert.match(theme, /\.photo-grid \{[^}]*repeat\(5, minmax\(0, 1fr\)\)/);
	assert.match(theme, /\.photo-grid\[data-custom-size\] \{[^}]*auto-fill/);
	assert.match(theme, /@media \(max-width: 64rem\)[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
	assert.match(theme, /@media \(max-width: 40rem\)[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
});

test("the admin bar is inserted after load, so cached public pages never depend on the session", async () => {
	const base = await read("src/layouts/Base.astro");
	const photos = await read("src/layouts/Photos.astro");
	const client = await read("src/client/admin-bar.ts");
	const endpoint = await read("src/pages/admin-bar/bar.astro");
	const marker = await read("src/pages/admin-bar.ts");
	const middleware = await read("src/middleware.ts");
	const admin = await read("src/studio/admin.tsx");
	const theme = await read("src/styles/theme.css");
	for (const layout of [base, photos]) {
		// The server HTML is the same for everyone; no session-dependent bar.
		assert.doesNotMatch(layout, /<AdminBar|locals\.user/);
		assert.match(layout, /kanouk-admin-bar=1\(\?:;\|\$\)\/\.test\(document\.cookie\) && document\.documentElement\.classList\.add\("has-admin-bar"\)/);
		assert.match(layout, /mountAdminBar\(\)/);
	}
	assert.match(base, /data-admin-site="blog"/);
	assert.match(photos, /data-admin-site="photos"/);
	// The blog endpoint checks the real session and clears a stale marker.
	assert.match(endpoint, /site === "blog" && !user/);
	assert.match(endpoint, /kanouk-admin-bar=; Path=\/; Max-Age=0/);
	assert.match(endpoint, /export const partial = true/);
	assert.match(middleware, /pathname\.startsWith\("\/admin-bar"\)/);
	assert.doesNotMatch(middleware, /kanouk-admin-bar/);
	assert.match(marker, /httpOnly: false/);
	assert.match(marker, /Not Found/);
	// The admin marks the browser; logout clears both sites.
	assert.match(admin, /markAdminPresent\(\)/);
	assert.match(client, /"X-EmDash-Request": "1"/);
	assert.match(client, /markPhotoSite\("off"\)/);
	assert.match(theme, /:root\.has-admin-bar \{ --admin-bar: /);
	assert.match(theme, /\.site-header \{[^}]*top: var\(--admin-bar\)/);
	assert.doesNotMatch(theme, /calc\(100svh - var\(--header-height\)\)/);
});

test("/admin on either site leads to the blog's admin without being cached", async () => {
	const middleware = await read("src/middleware.ts");
	assert.match(middleware, /pathname === "\/admin" \|\| context\.url\.pathname === "\/admin\/"/);
	assert.match(middleware, /isPhotoHost \? `\$\{blogOrigin\}\/_emdash\/admin` : "\/_emdash\/admin"/);
});

test("photos are public only with a published album, and search shows them as pictures", async () => {
	const [photoPage, search, images, theme] = await Promise.all([
		read("src/pages/p/[slug].astro"),
		read("src/pages/photo-search.astro"),
		read("src/utils/search-images.ts"),
		read("src/styles/theme.css"),
	]);
	assert.match(photoPage, /if \(photo\.data\.album && !album\) return Astro\.redirect\("\/404"\)/);
	assert.match(images, /a\.status = 'published' AND a\.deleted_at IS NULL/);
	assert.match(search, /class="photo-search-photos"/);
	assert.match(search, /images\.has\(result\.id\)/);
	// Pages end with --page-space; the footer adds only a small margin (no 200px gap on phones).
	assert.match(theme, /\.site-footer \{ margin-top: var\(--space-6\);/);
	assert.doesNotMatch(theme, /room for the floating size control/);
});
