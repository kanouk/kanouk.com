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

test("the admin bar is rendered only for a signed-in user and keeps the sticky chrome aligned", async () => {
	const base = await read("src/layouts/Base.astro");
	const bar = await read("src/components/AdminBar.astro");
	const theme = await read("src/styles/theme.css");
	assert.match(base, /\{isLoggedIn && <AdminBar /);
	assert.match(base, /"has-admin-bar": isLoggedIn/);
	assert.doesNotMatch(base, /site-admin/);
	// Every link goes into the admin; logging out needs the CSRF header.
	assert.doesNotMatch(bar, /href="https?:/);
	assert.match(bar, /"X-EmDash-Request": "1"/);
	assert.match(theme, /:root\.has-admin-bar \{ --admin-bar: /);
	assert.match(theme, /\.site-header \{[^}]*top: var\(--admin-bar\)/);
	assert.match(theme, /--header-offset: calc\(var\(--header-height\) \+ var\(--admin-bar\)\)/);
});
