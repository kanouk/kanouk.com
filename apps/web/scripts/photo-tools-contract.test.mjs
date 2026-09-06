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

test("selected photo and album editors save against their hydrated revision", async () => {
	const admin = await read("../src/studio/admin.tsx");
	const photoSave = admin.slice(admin.indexOf("const savePhoto"), admin.indexOf("const publishMany"));
	const albumSave = admin.slice(admin.indexOf("const saveAlbumDraft"), admin.indexOf("const savePhoto"));
	assert.match(admin, /getContent\("photos", inspectorPhoto\.id\)/);
	assert.match(admin, /getContent\("albums", selected\.id\)/);
	assert.match(photoSave, /updateDraft\("photos", photo\.id, photo\._rev/);
	assert.doesNotMatch(photoSave, /getContent\("photos", photo\.id\)/);
	assert.match(albumSave, /updateDraft\("albums", album\.id, album\._rev/);
	assert.doesNotMatch(albumSave, /getContent\("albums", album\.id\)/);
});

test("public media classifier and authenticated preview cache path fail closed", async () => {
	const worker = await read("../src/worker.ts");
	const mediaRoute = await read("../src/pages/media/[slug].ts");
	const {
		applyMediaAccessHeaders,
		classifyMediaRead,
		deniedMediaResponse,
		mediaPreviewDelivery,
	} = await import("../src/studio/public-media-guard.ts");
	const noPublicReference = {
		prepare() {
			return { bind: () => ({ first: async () => null }) };
		},
	};
	const rawRequest = new Request(
		"https://blog.kanouk.com/_emdash/api/media/file/unpublished.jpg",
	);
	assert.equal((await classifyMediaRead(rawRequest, noPublicReference)).access, "denied");
	assert.equal((await classifyMediaRead(rawRequest, noPublicReference, {
		authenticate: async () => true,
	})).access, "authenticated");
	assert.equal(mediaPreviewDelivery("authenticated"), "direct-private");
	assert.equal(mediaPreviewDelivery("denied"), "deny");
	const privateResponse = applyMediaAccessHeaders(new Response("image", {
		headers: { "Cache-Control": "public, max-age=31536000, immutable" },
	}), "authenticated");
	assert.equal(privateResponse.headers.get("Cache-Control"), "private, no-store");
	assert.match(privateResponse.headers.get("Vary") ?? "", /Cookie/);
	assert.match(privateResponse.headers.get("Vary") ?? "", /Authorization/);
	assert.equal(deniedMediaResponse().status, 404);
	assert.match(worker, /PHOTO_PUBLISH_ROUTE/);
	assert.match(worker, /LOCATION_REVIEW_REQUIRED/);
	assert.match(worker, /publish\|schedule/);
	assert.match(mediaRoute, /needsLocationReview/);
	assert.match(mediaRoute, /Location metadata review required/);
});
