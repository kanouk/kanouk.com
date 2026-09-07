import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../plugins/yohaku-content-blocks/src/astro/Dialogue.astro", import.meta.url), "utf8");

test("dialogue avatars have no decorative frame or shadow", () => {
	const avatar = source.match(/\.yohaku-dialogue__avatar \{([^}]+)\}/)?.[1];
	assert.ok(avatar);
	assert.match(avatar, /border: 0;/);
	assert.match(avatar, /background: transparent;/);
	assert.match(avatar, /box-shadow: none;/);
});

test("thinking bubbles use two detached circles on either side", () => {
	assert.match(source, /\.is-thinking \.yohaku-dialogue__bubble::after/);
	assert.match(source, /width: 0\.65rem;[\s\S]*width: 0\.4rem;/);
	assert.match(source, /\.is-thinking\.is-right \.yohaku-dialogue__bubble::before \{ right: -0\.9rem; left: auto; \}/);
	assert.match(source, /\.is-thinking\.is-right \.yohaku-dialogue__bubble::after \{ right: -1\.45rem; left: auto; \}/);
	assert.match(source, /var\(--thought-fill\)/);
	assert.match(source, /\.yohaku-dialogue:not\(\.is-thinking\)/);
});
