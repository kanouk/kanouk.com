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
	assert.match(theme, /\.article-content > h4::before,[\s\S]*width: 1rem;[\s\S]*height: 1px;[\s\S]*background: var\(--ink-muted\);/);
	assert.match(theme, /--image-display-width, 30rem/);
	assert.match(image, /node\.displayWidth \? `--image-display-width:\$\{node\.displayWidth\}px`/);
	assert.match(image, /"photo-frame" \| "border" \| "shadow" \| "none"/);
	for (const style of ["photo-frame", "border", "shadow", "none"]) {
		assert.match(theme, new RegExp(`\\.yohaku-portable-image\\.style-${style}`));
	}
});

test("album and photo patterns have stable responsive defaults", async () => {
	const theme = await read("src/styles/theme.css");
	assert.match(theme, /\.album-feature-card \{/);
	assert.match(theme, /\.album-related-posts \{/);
	assert.match(theme, /\.photo-grid \{[^}]*repeat\(5, minmax\(0, 1fr\)\)/);
	assert.match(theme, /\.photo-grid\[data-custom-size\] \{[^}]*auto-fill/);
	assert.match(theme, /@media \(max-width: 64rem\)[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
	assert.match(theme, /@media \(max-width: 40rem\)[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
});
