import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Studio is an EmDash adapter and does not directly access D1 or R2", async () => {
	const sources = await Promise.all([
		"../src/studio/api.ts",
		"../src/studio/admin.tsx",
		"../src/pages/studio/api/public-content.ts",
	].map(read));
	const combined = sources.join("\n");
	assert.match(combined, /apiFetch|locals\.emdash/);
	assert.doesNotMatch(combined, /\.prepare\(|\.exec\(|\.batch\(|R2Bucket|D1Database/);
});

test("public management UI and data are absent without a Studio session", async () => {
	const component = await read("../src/components/StudioPhotoAdmin.astro");
	assert.match(component, /\{session && \(/);
	assert.match(component, /data-studio-public-admin/);
	assert.match(component, /<script is:inline>/);
	assert.ok(component.indexOf("{session && (") < component.indexOf("<script is:inline>"));
	assert.match(component, /管理モードをON/);
});

test("photo-host writes require revision tokens and use field allowlists", async () => {
	const api = await read("../src/pages/studio/api/public-content.ts");
	assert.match(api, /const FIELDS/);
	assert.match(api, /_rev/);
	assert.match(api, /isSameOriginMutation/);
	assert.match(api, /Cache-Control": "private, no-store"/);
	assert.doesNotMatch(api, /latitude.*longitude.*altitude.*new Set/s);
});

test("Studio private state bypasses public edge caching", async () => {
	const middleware = await read("../src/middleware.ts");
	const handoff = await read("../src/pages/studio/handoff.ts");
	const session = await read("../src/pages/studio/api/session.ts");
	assert.match(middleware, /studio-photo-session/);
	assert.match(middleware, /Cache-Control", "private, no-store"/);
	assert.match(handoff, /cookies\.set\("emdash-edit-mode", "true"/);
	assert.match(session, /cookies\.delete\("emdash-edit-mode"/);
});

test("native plugin registers the complete daily workflow and P0 extensions", async () => {
	const descriptor = await read("../src/studio/plugin.ts");
	const admin = await read("../src/studio/admin.tsx");
	for (const route of ["/articles", "/pages", "/photos", "/albums", "/review", "/media"]) {
		assert.match(descriptor, new RegExp(`path: "${route}"`));
	}
	assert.match(admin, /contentListColumns/);
	assert.match(admin, /contentEditorPanels/);
	assert.match(admin, /createArticleDraft/);
	assert.match(admin, /createDraft\("albums"/);
});
