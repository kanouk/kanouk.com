import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";
import {
  blockEditorExtensions,
  findRelatedAlbumId,
  mediaSummary,
  photoPickerExtension,
} from "../plugins/yohaku-content-blocks/src/admin/block-editors.mjs";

const pluginSourceUrl = new URL(
  "../plugins/yohaku-content-blocks/src/index.ts",
  import.meta.url,
);
const relatedMediaSourceUrl = new URL(
  "../plugins/yohaku-content-blocks/src/related-media.ts",
  import.meta.url,
);
const photoComponentUrl = new URL(
  "../plugins/yohaku-content-blocks/src/astro/Photo.astro",
  import.meta.url,
);
const albumComponentUrl = new URL(
  "../plugins/yohaku-content-blocks/src/astro/Album.astro",
  import.meta.url,
);

test("related album and photo blocks use exact content IDs and authenticated options routes", async () => {
  const source = (
    await Promise.all([
      readFile(pluginSourceUrl, "utf8"),
      readFile(relatedMediaSourceUrl, "utf8"),
    ])
  ).join("\n");

  assert.match(source, /type: "yohaku\.album"/);
  assert.match(source, /dynamicSelect\("id", "アルバム", "albums\/options"\)/);
  assert.match(source, /type: "yohaku\.photo"/);
  assert.match(
    source,
    /dynamicSelect\("albumId", "アルバム", "albums\/options"\)/,
  );
  assert.match(source, /"photos\/options",[\s\S]*\["albumId"\]/);
  assert.match(source, /permission: "content:edit_any"/);
  assert.match(source, /capabilities: \[[^\]]*"content:read"/);
  assert.match(source, /where: \{ fieldFilters: \{ album: albumId \} \}/);
  assert.doesNotMatch(source, /orderBy: \{ captured_from:/);
});

test("photo metadata is copied into article-local fields with persistent presentation controls", async () => {
  const source = await readFile(relatedMediaSourceUrl, "utf8");

  assert.match(source, /caption: textValue\(photo\.data\.caption\)/);
  assert.match(source, /action_id: "caption"/);
  assert.match(source, /initial_value: 480/);
  assert.match(source, /action_id: "displayWidth"/);
  for (const frame of ["photo-frame", "border", "shadow", "none"]) {
    assert.match(source, new RegExp(`value: "${frame}"`));
  }
  assert.match(source, /type: "yohaku\.youtube"/);
  assert.match(source, /YouTube URL または動画ID/);
});

test("link cards persist editable OGP metadata alongside the target URL", async () => {
  const source = await readFile(pluginSourceUrl, "utf8");

  assert.match(source, /type: "yohaku\.linkCard"/);
  assert.match(source, /action_id: "id", label: "URL"/);
  assert.match(source, /action_id: "title", label: "タイトル"/);
  assert.match(source, /action_id: "description", label: "説明"/);
  assert.match(source, /action_id: "imageUrl", label: "プレビュー画像URL"/);
});

test("public photo renderer resolves live published rows and verifies the album relationship", async () => {
  const [photo, album] = await Promise.all([
    readFile(photoComponentUrl, "utf8"),
    readFile(albumComponentUrl, "utf8"),
  ]);

  assert.match(photo, /status: "published"/);
  assert.match(photo, /photo\.data\.album === albumId/);
  assert.match(photo, /status: "published"[\s\S]*where: \{ id: albumId \}/);
  assert.doesNotMatch(photo, /node\.imageUrl/);
  assert.match(photo, /YohakuPortableImage/);
  assert.match(album, /status: "published"/);
  assert.match(album, /album-feature-card/);
});

function editorWithAlbums(albums) {
  return {
    state: {
      doc: {
        descendants(visit) {
          for (const [pos, id] of albums) visit({ type: { name: "pluginBlock" }, attrs: { blockType: "yohaku.album", id } }, pos);
          visit({ type: { name: "paragraph" }, attrs: {} }, 99);
        },
      },
    },
  };
}

test("new photo blocks prefer the article related album, then the nearest preceding album block", () => {
  const editor = editorWithAlbums([[10, "album-a"], [30, "album-b"]]);
  const photo = { type: "yohaku.photo" };
  assert.deepEqual(photoPickerExtension.insertDefaults({ block: photo, editor, insertPos: 40, documentData: { related_album: " related " } }), { albumId: "related" });
  assert.deepEqual(photoPickerExtension.insertDefaults({ block: photo, editor, insertPos: 20, documentData: { related_album: "" } }), { albumId: "album-a" });
  assert.deepEqual(photoPickerExtension.insertDefaults({ block: photo, editor, insertPos: 5, documentData: undefined }), { albumId: "album-a" });
  assert.equal(findRelatedAlbumId(editor, 40), "album-b");
  assert.equal(photoPickerExtension.insertDefaults({ block: photo, editor: editorWithAlbums([]), insertPos: 0 }), undefined);
  assert.equal(photoPickerExtension.insertDefaults({ block: { type: "yohaku.album" }, editor, insertPos: 40, documentData: { related_album: "x" } }), undefined);
});

test("photo options render a thumbnail picker that selects through the dialog", () => {
  const { fieldAddon } = photoPickerExtension.useModal();
  const options = [
    { value: "p1", label: "1", values: { imageUrl: "https://photos.kanouk.com/1.jpg" } },
    { value: "p2", label: "2", values: {} },
  ];
  assert.equal(fieldAddon({ field: { optionsRoute: "albums/options" }, options, value: "", select() {} }), null);
  const selected = [];
  const addon = fieldAddon({ field: { optionsRoute: "photos/options" }, options, value: "p1", select: (value) => selected.push(value) });
  const html = renderToStaticMarkup(addon);
  assert.match(html, /role="listbox" aria-label="写真をサムネイルから選択"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /写真 1 を選択/);
  assert.doesNotMatch(html, /写真 2 を選択/);
  const picker = addon.type(addon.props);
  picker.props.children[0].props.onClick();
  assert.deepEqual(selected, ["p1"]);
});

test("inserted photo, album and link card blocks show their media, title and public URL", () => {
  const local = { hostname: "127.0.0.1", origin: "http://127.0.0.1:4321" };
  const production = { hostname: "blog.kanouk.com", origin: "https://blog.kanouk.com" };
  assert.deepEqual(mediaSummary({ blockType: "yohaku.photo", id: "01P", data: { imageUrl: "/i.jpg", caption: "", alt: "alt", photoSlug: "slug a" } }, production), {
    imageUrl: "/i.jpg", imageReferrerPolicy: undefined, title: "alt", externalUrl: "https://photos.kanouk.com/p/slug%20a",
  });
  assert.equal(mediaSummary({ blockType: "yohaku.album", id: "01A", data: { albumTitleSnapshot: "旅" } }, local).externalUrl, "http://127.0.0.1:4321/albums/01A");
  const card = mediaSummary({ blockType: "yohaku.linkCard", id: "https://example.com/", data: { title: "", linkPreviewAuto: { version: 1, url: "https://example.com/", title: "自動", imageUrl: "https://example.com/og.jpg" } } }, production);
  assert.deepEqual(card, { imageUrl: "https://example.com/og.jpg", imageReferrerPolicy: "no-referrer", title: "自動", externalUrl: undefined });
  assert.equal(mediaSummary({ blockType: "yohaku.embed", id: "x", data: {} }, production), null);
});

test("block editor UI only uses utilities present in the distributed admin CSS", async () => {
  const [styles, sources] = await Promise.all([
    readFile(new URL("../node_modules/@emdash-cms/admin/dist/styles.css", import.meta.url), "utf8"),
    Promise.all(["block-editors.mjs", "embed-preview.mjs"].map((file) => readFile(new URL(`../plugins/yohaku-content-blocks/src/admin/${file}`, import.meta.url), "utf8"))),
  ]);
  const classValues = [...sources.join("\n").matchAll(/className: (?:[^,{}]*?\? )?"([^"]*)"(?: : "([^"]*)")?/g)].flatMap(([, first, second]) => [first, second ?? ""]);
  const classNames = new Set(classValues.flatMap((value) => value.split(/\s+/)).filter(Boolean));
  assert.ok(classNames.has("ring-2") && classNames.has("text-kumo-danger"));
  const escape = (name) => name.replace(/[/:.[\]]/g, (char) => `\\${char}`);
  for (const name of classNames) assert.ok(styles.includes(`.${escape(name)}`), `${name} must exist in distributed CSS`);
  assert.equal(blockEditorExtensions.length, 4);
});
