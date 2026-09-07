import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("posts define one optional indexed albums reference hidden behind the native panel", async () => {
	const seed = JSON.parse(await readFile(new URL("../seed/seed.json", import.meta.url), "utf8"));
	const posts = seed.collections.find((collection) => collection.slug === "posts");
	const matching = posts.fields.filter((field) => field.slug === "related_album");
	assert.equal(matching.length, 1);
	assert.deepEqual(matching[0], {
		slug: "related_album",
		label: "関連アルバム",
		type: "reference",
		options: { collection: "albums" },
		widget: "yohaku-photo-tools:related-album-hidden",
		indexed: true,
	});
});

test("the related album panel writes article data only through the host form", async () => {
	const source = await readFile(new URL("../src/studio/admin.tsx", import.meta.url), "utf8");
	assert.match(source, /supportsNew: true, component: RelatedAlbumPanel/);
	assert.match(source, /onFieldChange\?\.\("related_album", albumId\)/);
	assert.match(source, /draftData \?\? entry\?\.data \?\? \{\}/);
	assert.match(source, /"related-album-hidden": HiddenRelatedAlbumField/);
	assert.match(source, /解除しても、本文のアルバムカードや挿入済み写真・キャプションは残ります/);
	assert.doesNotMatch(source, /\/_emdash\/api\/content\/posts/);
	assert.doesNotMatch(source, /updateDraft\("posts"/);
});
