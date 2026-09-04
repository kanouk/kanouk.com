import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("EmDash is the only admin shell and the plugin exposes one photo organizer", async () => {
	const descriptor = await read("../src/studio/plugin.ts");
	const admin = await read("../src/studio/admin.tsx");
	assert.match(descriptor, /id: "yohaku-photo-tools"/);
	assert.match(descriptor, /path: "\/organize", label: "写真を整理"/);
	for (const removed of ["/articles", "/pages", "/photos", "/albums", "/review", "/media"]) {
		assert.doesNotMatch(descriptor, new RegExp(`path: "${removed}"`));
	}
	assert.deepEqual([...admin.matchAll(/^export function (\w+Page)/gm)].map((match) => match[1]), ["PhotoOrganizerPage"]);
	assert.match(admin, /contentListColumns/);
	assert.match(admin, /contentEditorPanels/);
});

test("photo organizer uses EmDash APIs and never writes D1 or R2 directly", async () => {
	const combined = (await Promise.all([
		"../src/studio/api.ts",
		"../src/studio/admin.tsx",
		"../src/studio/runtime.ts",
	].map(read))).join("\n");
	assert.match(combined, /apiFetch/);
	assert.doesNotMatch(combined, /\.prepare\(|\.exec\(|\.batch\(|R2Bucket|D1Database/);
});

test("public photo pages no longer ship a second management UI", async () => {
	const layout = await read("../src/layouts/Photos.astro");
	const middleware = await read("../src/middleware.ts");
	assert.doesNotMatch(layout, /StudioPhotoAdmin|studio-public-admin|管理モードをON/);
	assert.match(middleware, /PUBLIC_MEDIA_READ_ROUTE/);
	assert.match(middleware, /isPhotoHost && context\.url\.pathname\.startsWith\("\/_emdash\/"\)/);
	assert.match(middleware, /return privateNotFound\(\)/);
	for (const path of [
		"../src/components/StudioPhotoAdmin.astro",
		"../src/pages/studio/handoff.ts",
		"../src/pages/studio/api/public-content.ts",
		"../src/pages/studio/api/public-media.ts",
		"../src/pages/studio/api/session.ts",
	]) {
		await assert.rejects(access(new URL(path, import.meta.url)));
	}
});

test("album organizer owns upload, reorder, batch edit and aggregate publish", async () => {
	const admin = await read("../src/studio/admin.tsx");
	const css = await read("../src/studio/studio.css");
	assert.match(admin, /写真を追加/);
	assert.match(admin, /persistOrder/);
	assert.match(admin, /applyBulkPatch/);
	assert.match(admin, /publishWorkspace/);
	assert.match(admin, /アルバムを公開/);
	assert.match(admin, /変更を公開/);
	assert.match(admin, /失敗した写真だけを選択状態に残します/);
	const workspaceStart = admin.indexOf("const publishWorkspace");
	const photoPublish = admin.indexOf('publishDraft("photos", id)', workspaceStart);
	const albumPublish = admin.indexOf('publishDraft("albums", album.id)', workspaceStart);
	assert.ok(workspaceStart >= 0 && photoPublish > workspaceStart && albumPublish > photoPublish);
	assert.match(admin.slice(workspaceStart, albumPublish), /albumSaveFailed/);
	assert.match(admin, /photo-tools-mobile-tabs/);
	assert.match(admin, /photo-tools-mobile-subtabs/);
	assert.match(admin, /fieldFilters: \{ album: selectedId \}/);
	assert.match(admin, /albumReady/);
	assert.match(admin, /setReadyAlbumId\(""\)/);
	assert.match(admin, /photoDraftDirty/);
	assert.match(admin, /ACCEPTED_IMAGE_TYPES/);
	assert.match(admin, /原本の位置情報が未確認です/);
	assert.match(css, /\.photo-tools-organizer\.is-mobile-workspace > \.photo-tools-album-rail/);
	assert.match(css, /\.photo-tools-content\.is-mobile-info > \.photo-tools-grid-area/);
});

test("public previews fail closed and unreviewed originals cannot be downloaded", async () => {
	const worker = await read("../src/worker.ts");
	const publicMediaGuard = await read("../src/studio/public-media-guard.ts");
	const mediaRoute = await read("../src/pages/media/[slug].ts");
	assert.match(worker, /Image preview is temporarily unavailable/);
	assert.doesNotMatch(worker, /if \(!transformed\) \{\s*return handler\.fetch/);
	assert.match(worker, /PHOTO_PUBLISH_ROUTE/);
	assert.match(worker, /LOCATION_REVIEW_REQUIRED/);
	assert.match(worker, /publish\|schedule/);
	assert.match(worker, /guardPublicOriginalRead/);
	assert.match(publicMediaGuard, /JOIN revisions AS live ON live\.id = photo\.live_revision_id/);
	assert.match(publicMediaGuard, /photo\.deleted_at IS NULL/);
	assert.match(publicMediaGuard, /location_review'\) = 'clean'/);
	assert.match(mediaRoute, /needsLocationReview/);
	assert.match(mediaRoute, /Location metadata review required/);
});
