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
	const [profile, image, theme, imageStyles] = await Promise.all([
		read("src/components/ProfileCard.astro"),
		read("src/components/YohakuPortableImage.astro"),
		read("src/styles/theme.css"),
		read("src/styles/article-image-styles.css"),
	]);
	assert.match(profile, /profile-card__identity[\s\S]*<h2>カノ<\/h2>[\s\S]*profile-card__type">INFP/);
	assert.match(theme, /\.profile-card__copy \{[\s\S]*border-top: 1px solid var\(--rule\);[\s\S]*text-align: left;/);
	assert.match(theme, /\.article-content > h2,[\s\S]*box-shadow: inset 3px 0 0 var\(--accent\);/);
	assert.match(theme, /\.article-content > h3,[\s\S]*border-bottom: 1px solid var\(--rule\);/);
	assert.match(theme, /\.article-content > h4,\n\.page-content > h4 \{[^}]*font-size: calc\(var\(--step-0\) \* 1\.06\);[^}]*font-weight: 700;/);
	assert.match(theme, /\.article-content > h4::before,\n\.page-content > h4::before \{[^}]*background: var\(--accent\);/);
	// Migrated posts use h5/h6 as section labels; they must never fall below body text size.
	for (const level of ["h5", "h6"]) {
		assert.match(theme, new RegExp(`\\.article-content > ${level},\\n\\.page-content > ${level} \\{[^}]*font-size: var\\(--step-0\\);`));
	}
	assert.match(theme, /\.article-content > h1,\n\.page-content > h1 \{[^}]*box-shadow: inset 3px 0 0 var\(--accent\);/);
	// Thumbnails get a small radius; the inset hairline follows it.
	assert.match(theme, /--radius-thumb: 4px;/);
	assert.match(theme, /\.card-image \{[^}]*border-radius: var\(--radius-thumb\);/);
	assert.match(theme, /a:is\(\.yohaku-link-card, \.album-feature-card\) \{ color: inherit; text-decoration: none; \}/, "album cards do not inherit the body-link underline");
	assert.match(theme, /\.article-pager__link \{[^}]*border-radius: calc\(var\(--radius-thumb\) \+ 2px\);/);
	assert.match(theme, /\.card-image:not\(\.card-image--empty\)::after \{[^}]*border-radius: inherit;/);
	assert.match(theme, /--image-display-width, 30rem/);
	assert.match(image, /node\.displayWidth \? `--image-display-width:\$\{node\.displayWidth\}px`/);
	assert.match(image, /resolveArticleImageStyle\(node\.visualStyle\)/);
	for (const style of ["photo-frame", "border", "shadow", "none", "rounded"]) {
		assert.match(imageStyles, new RegExp(`\\.yohaku-portable-image\\.style-${style}`));
	}
});

test("articles keep the old blog's way around: breadcrumb, older and newer posts, floating buttons", async () => {
	const [page, nav] = await Promise.all([read("src/pages/posts/[slug].astro"), read("src/client/article-nav.ts")]);
	assert.match(page, /class="article-breadcrumb"/);
	assert.match(page, /rel="prev"[\s\S]*前の記事[\s\S]*rel="next"[\s\S]*次の記事/);
	assert.match(page, /adjacentPostId\(env\.DB, post\.data\.publishedAt\.toISOString\(\), direction\)/);
	assert.match(page, /adjacentPost\("older"\)/);
	assert.match(page, /adjacentPost\("newer"\)/);
	assert.match(page, /data-article-top/);
	// Meta row order: date, reading time, then the author, each with its own icon.
	assert.match(page, /<CalendarDays[\s\S]*<Clock3[\s\S]*分で読む[\s\S]*article-meta-byline">\s*<UserRound/);
	assert.match(nav, /:is\(h2, h3, h4\)/);
});

test("article titles break between phrases, never before a particle or closing bracket", async () => {
	const { titlePhrases } = await import("../src/utils/title-phrases.mjs");
	const phrases = titlePhrases("AIエージェントのアーキテクチャから見つめ直す、システム設計と「人間」のマネジメント");
	assert.equal(phrases.join(""), "AIエージェントのアーキテクチャから見つめ直す、システム設計と「人間」のマネジメント");
	assert.ok(phrases.includes("「人間」の"), "a particle stays with the bracketed word before it");
	assert.ok(phrases.every((phrase) => !/^[のとをにはがで」、。）]/u.test(phrase)), JSON.stringify(phrases));
	assert.deepEqual(titlePhrases("京都旅行、そしてまた京都").slice(-2), ["そしてまた", "京都"], "hiragana after 、 starts a new phrase");
});

test("code blocks are drawn by the site theme, not EmDash's dark panel", async () => {
	const [blocks, code, theme] = await Promise.all([
		read("plugins/yohaku-content-blocks/src/astro/index.ts"),
		read("plugins/yohaku-content-blocks/src/astro/Code.astro"),
		read("src/styles/theme.css"),
	]);
	assert.match(blocks, /\bcode: Code,/);
	assert.match(code, /class="emdash-code"/);
	assert.doesNotMatch(code, /<style|#1e1e1e/);
	assert.match(theme, /\.page-content pre \{[^}]*background: var\(--paper-raised\);/);
	assert.match(theme, /\.page-content :where\(code\) \{[^}]*background: var\(--code-inline-bg\);[^}]*color: var\(--code-inline-ink\);/);
	assert.match(theme, /\.page-content pre code \{[^}]*border: 0;[^}]*background: none;[^}]*color: inherit;/);
});

test("album header keeps the article link short and the photos close", async () => {
	const album = await read("src/pages/albums/[slug].astro");
	assert.match(album, /<span>ブログ記事を読む\{/);
	assert.doesNotMatch(album, /album-head__action-title|album-related-posts/);
	assert.match(album, /aria-controls=\{mapPanelId\}/);
	assert.match(album, /displayTitle && !looksLikeSourceFilename\(displayTitle\)/, "file-name captions stay out of the grid");
	assert.equal(album.match(/<nav class="album-pagination archive-pagination"/g)?.length, 1, "pagination only below the photos, built from the blog's pagination parts");
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
	// Pages end with --page-space; the footer adds no margin of its own (no double-counted gap).
	assert.match(theme, /\.site-footer \{ margin-top: 0;/);
	assert.doesNotMatch(theme, /room for the floating size control/);
});
