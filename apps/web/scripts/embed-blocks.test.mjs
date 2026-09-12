import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const {
	EMBED_FULL_URL_GUIDANCE,
	embedParserBrowserSource,
	parseEmbedUrl,
} = await import("../plugins/yohaku-content-blocks/src/embed-url.mjs");
const { parseEmbedUrl: parseTypedEmbedUrl } = await import("../plugins/yohaku-content-blocks/src/embed-url.ts");
const { embedBlocks } = await import("../plugins/yohaku-content-blocks/src/embed-blocks.ts");

const SPOTIFY_ID = "7makk4oTQel546B0PZlDM5";

test("TikTok video and player URLs become a script-free official player URL", () => {
	const video = parseEmbedUrl("https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1");
	assert.equal(video.ok, true);
	assert.equal(video.provider, "tiktok");
	assert.equal(video.id, "6718335390845095173");
	assert.equal(video.canonicalUrl, "https://www.tiktok.com/@scout2015/video/6718335390845095173");
	assert.equal(video.embedUrl, "https://www.tiktok.com/player/v1/6718335390845095173?controls=1&progress_bar=1&closed_caption=1&description=1");
	assert.doesNotMatch(video.embedUrl, /autoplay/i);

	const player = parseEmbedUrl("https://www.tiktok.com/player/v1/6718335390845095173");
	assert.equal(player.ok, true);
	assert.equal(player.kind, "video");
});

test("Spotify supported content kinds canonicalize locale and embed URL variants", () => {
	for (const kind of ["track", "album", "playlist", "artist", "show", "episode"]) {
		const prefix = kind === "track" ? "/intl-ja/embed" : "";
		const parsed = parseEmbedUrl(`https://open.spotify.com${prefix}/${kind}/${SPOTIFY_ID}?si=tracking`);
		assert.equal(parsed.ok, true, kind);
		assert.equal(parsed.provider, "spotify", kind);
		assert.equal(parsed.kind, kind);
		assert.equal(parsed.canonicalUrl, `https://open.spotify.com/${kind}/${SPOTIFY_ID}`);
		assert.equal(parsed.embedUrl, `https://open.spotify.com/embed/${kind}/${SPOTIFY_ID}`);
		assert.equal(parsed.height, kind === "track" ? 80 : kind === "episode" ? 152 : 352);
	}
});

test("short URLs are not followed and explain how to obtain a full URL", () => {
	for (const input of [
		"https://vm.tiktok.com/ZMshort/",
		"https://vt.tiktok.com/ZMshort/",
		"https://www.tiktok.com/t/ZMshort/",
		"https://spotify.link/example",
	]) {
		const parsed = parseEmbedUrl(input);
		assert.equal(parsed.ok, false);
		assert.equal(parsed.reason, "short-url");
		assert.equal(parsed.message, EMBED_FULL_URL_GUIDANCE);
		assert.equal(parsed.safeUrl, input);
	}
});

test("non-HTTPS, credentialed, ported, arbitrary, and unsupported URLs fail closed", () => {
	for (const input of [
		"http://open.spotify.com/track/7makk4oTQel546B0PZlDM5",
		"https://user:secret@open.spotify.com/track/7makk4oTQel546B0PZlDM5",
		"https://open.spotify.com:444/track/7makk4oTQel546B0PZlDM5",
		"https://evil.example/track/7makk4oTQel546B0PZlDM5",
		"https://open.spotify.com/user/someone",
		"https://www.tiktok.com/@scout2015",
		"javascript:alert(1)",
	]) {
		assert.equal(parseEmbedUrl(input).ok, false, input);
	}
});

test("typed and browser-injected parsers use the same self-contained implementation", () => {
	const browserSource = embedParserBrowserSource();
	assert.match(browserSource, /^const parseEmbedUrl = /);
	assert.doesNotMatch(browserSource, /\b(?:import|require)\b/);
	const parseBrowserEmbedUrl = Function(`${browserSource}\nreturn parseEmbedUrl;`)();
	for (const input of [
		"https://www.tiktok.com/@scout2015/video/6718335390845095173",
		`https://open.spotify.com/episode/${SPOTIFY_ID}`,
		"https://spotify.link/example",
		"https://example.com/not-supported",
		"",
	]) {
		const expected = parseEmbedUrl(input);
		assert.deepEqual(parseTypedEmbedUrl(input), expected, `typed: ${input}`);
		assert.deepEqual(parseBrowserEmbedUrl(input), expected, `browser: ${input}`);
	}
});

test("one block preserves URL, display choice, and caption across mode switches", () => {
	assert.equal(embedBlocks.length, 1);
	const [block] = embedBlocks;
	assert.equal(block.type, "yohaku.embed");
	assert.deepEqual(block.fields?.map((field) => field.action_id), ["id", "display", "caption"]);
	const display = block.fields?.find((field) => field.action_id === "display");
	assert.equal(display?.initial_value, "player");
	assert.deepEqual(display?.options?.map((option) => option.value), ["player", "link-card"]);
	assert.equal(block.fields?.find((field) => field.action_id === "caption")?.multiline, true);
});

test("Astro renderer is click-to-load, keeps a source link, and registers without arbitrary HTML", async () => {
	const [component, registry] = await Promise.all([
		readFile(new URL("../plugins/yohaku-content-blocks/src/astro/Embed.astro", import.meta.url), "utf8"),
		readFile(new URL("../plugins/yohaku-content-blocks/src/astro/index.ts", import.meta.url), "utf8"),
	]);
	assert.match(registry, /"yohaku\.embed": Embed/);
	assert.match(component, /data-yohaku-embed-load/);
	assert.match(component, /document\.createElement\("iframe"\)/);
	assert.match(component, /\.yohaku-embed__stage :global\(iframe\)/);
	assert.match(component, /\.yohaku-embed__load \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/);
	assert.match(component, /<\/div>\s*\{caption && <figcaption>\{caption\}<\/figcaption>}\s*<a class="yohaku-embed__source"/);
	assert.doesNotMatch(component, /yohaku-embed__footer/);
	assert.match(component, /クリックするまで外部コンテンツは読み込まれません/);
	assert.match(component, /で開く/);
	assert.match(component, /loading = "lazy"/);
	assert.match(component, /encrypted-media; fullscreen; picture-in-picture/);
	assert.doesNotMatch(component, /set:html|innerHTML|<script\s+src=|autoplay/);
});
