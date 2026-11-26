import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { desiredOrder, ensurePostEditorLayout, inspectPostEditorLayout, POST_EDITOR_LAYOUT } from "./ensure-post-editor-layout.mjs";

const live = () => [
	{ slug: "title", type: "string", sortOrder: 0, validation: null },
	{ slug: "featured_image", type: "image", sortOrder: 1, validation: null },
	{ slug: "content", type: "portableText", sortOrder: 2, validation: null },
	{ slug: "related_album", type: "reference", sortOrder: 3, widget: "yohaku-photo-tools:related-album-hidden", options: { collection: "albums" } },
	{ slug: "excerpt", type: "text", sortOrder: 4, validation: { maxLength: 400 }, options: { placeholder: "x" } },
	{ slug: "published_on", type: "datetime", sortOrder: 5 },
];

function fakeClient(fields) {
	const calls = [];
	return {
		calls,
		async get() { return { data: { items: structuredClone(fields) } }; },
		async put(pathname, body) {
			calls.push(["PUT", pathname, body]);
			Object.assign(fields.find((field) => pathname.endsWith(`/${field.slug}`)), body);
		},
		async post(pathname, body) {
			calls.push(["POST", pathname, body]);
			body.fieldSlugs.forEach((slug, index) => { fields.find((field) => field.slug === slug).sortOrder = index; });
		},
	};
}

test("the editor reads in article order: title, featured image, excerpt, body, then the rest unchanged", () => {
	assert.deepEqual(desiredOrder(live()), ["title", "featured_image", "excerpt", "content", "related_album", "published_on"]);
});

test("dry run plans every change without writing", async () => {
	const client = fakeClient(live());
	const result = await ensurePostEditorLayout(client);
	assert.equal(result.action, "would-update");
	assert.deepEqual(result.before.pending, ["order", "featured_image.widget", "excerpt.options.rows"]);
	assert.equal(client.calls.length, 0);
});

test("apply sends the full slug list, keeps existing options and validation, then verifies", async () => {
	const fields = live();
	const client = fakeClient(fields);
	const result = await ensurePostEditorLayout(client, { apply: true });
	assert.equal(result.action, "updated");
	const excerptPut = client.calls.find(([, pathname]) => pathname.endsWith("/excerpt"))[2];
	assert.deepEqual(excerptPut, { validation: { maxLength: 400 }, options: { placeholder: "x", rows: 3 } });
	const featuredPut = client.calls.find(([, pathname]) => pathname.endsWith("/featured_image"))[2];
	assert.deepEqual(featuredPut, { validation: null, widget: POST_EDITOR_LAYOUT.featuredWidget });
	const reorder = client.calls.find(([method]) => method === "POST")[2];
	assert.equal(reorder.fieldSlugs.length, fields.length, "every slug is sent so none keep a clashing sort order");
	assert.equal(inspectPostEditorLayout(fields).status, "ready");
	assert.equal((await ensurePostEditorLayout(fakeClient(fields), { apply: true })).action, "unchanged");
});

test("an unexpected schema stops before any write", async () => {
	const fields = live().filter((field) => field.slug !== "excerpt");
	const client = fakeClient(fields);
	await assert.rejects(ensurePostEditorLayout(client, { apply: true }), /missing fields: excerpt/);
	assert.equal(client.calls.length, 0);
});

test("the compact featured image widget is registered and stores EmDash's own image value", async () => {
	const admin = await readFile(new URL("../src/studio/admin.tsx", import.meta.url), "utf8");
	assert.match(admin, /"featured-image-compact": CompactFeaturedImageField/);
	assert.match(admin, /import \{ MediaPickerModal \} from "@emdash-cms\/admin";/);
	assert.match(admin, /meta = local \? \{ \.\.\.item\.meta, storageKey: item\.storageKey \} : item\.meta/);
	const seed = JSON.parse(await readFile(new URL("../seed/seed.json", import.meta.url), "utf8"));
	const posts = seed.collections.find((collection) => collection.slug === "posts");
	assert.deepEqual(posts.fields.slice(0, 4).map((field) => field.slug), POST_EDITOR_LAYOUT.leading);
	assert.equal(posts.fields[1].widget, POST_EDITOR_LAYOUT.featuredWidget);
	assert.equal(posts.fields[2].options.rows, POST_EDITOR_LAYOUT.excerptRows);
});

test("the admin offers the same layout change as a one-click panel, only while it is pending", async () => {
	const admin = await readFile(new URL("../src/studio/admin.tsx", import.meta.url), "utf8");
	assert.match(admin, /import \{ ensurePostEditorLayout, readPostEditorLayout \} from "\.\.\/utils\/post-editor-layout\.mjs";/);
	assert.match(admin, /id: "post-editor-layout"[^}]*isVisible: postEditorLayoutPending[^}]*component: PostEditorLayoutPanel/);
	assert.match(admin, /ensurePostEditorLayout\(schemaClient, \{ apply: true \}\)/);
});
