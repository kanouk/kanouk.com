import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { patchEmDashRelatedMediaSource } from "./patch-emdash-admin-related-media.mjs";

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

test("installed editor patch prefers the article related album and hydrates dependent fields", async () => {
  const [installedBundle, installedStyles] = await Promise.all([
    readFile(
      new URL("../node_modules/@emdash-cms/admin/dist/index.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../node_modules/@emdash-cms/admin/dist/styles.css", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(installedBundle, /emdash-kanouk-related-media-picker-v1/);
  assert.match(
    installedBundle,
    /function findRelatedAlbumId\(editor, beforePos\)/,
  );
  assert.match(installedBundle, /block\.type === "yohaku\.photo"/);
  assert.match(
    installedBundle,
    /setPluginBlockDefaultValues\(defaultAlbumId \? \{ albumId: defaultAlbumId \}/,
  );
  assert.match(installedBundle, /emdash-kanouk-related-album-setting-v7/);
  assert.match(installedBundle, /extension\.supportsNew === true/);
  assert.match(installedBundle, /draftData: formData/);
  assert.match(installedBundle, /onDraftFieldChange: handleFieldChange/);
  assert.match(installedBundle, /relatedAlbumId: typeof formData\.related_album === "string"/);
  assert.match(
    installedBundle,
    /relatedAlbumId\.trim\(\) \? relatedAlbumId\.trim\(\) : findRelatedAlbumId/,
  );
  assert.match(
    installedBundle,
    /body: JSON\.stringify\(\{ values: formValues \?\? \{\} \}\)/,
  );
  assert.match(installedBundle, /selectedOption\?\.values/);
  assert.match(installedBundle, /emdash-kanouk-related-media-distributed-css-v3/);
  assert.match(installedBundle, /"aria-label": "写真をサムネイルから選択"/);
  assert.match(installedBundle, /role: "listbox"/);
  assert.match(installedBundle, /role: "alert"/);
  assert.match(installedBundle, /mediaImageUrl/);
  assert.match(installedBundle, /albumTitleSnapshot/);
  assert.match(installedBundle, /data\.photoSlug/);
  assert.match(installedBundle, /data\.albumSlug/);
  assert.match(installedBundle, /navigator\.clipboard\.writeText\(publicMediaUrl\)/);
  assert.match(installedBundle, /emdash-kanouk-link-preview-https-v6/);
  assert.match(
    installedBundle,
    /\/_emdash\/api\/plugins\/\$\{block\.pluginId\}\/link-preview/,
  );
  assert.match(installedBundle, /setTimeout\(async \(\) => \{[\s\S]*?\}, 500\)/);
  assert.match(installedBundle, /const controller = new AbortController\(\)/);
  assert.match(
    installedBundle,
    /requestVersion !== linkPreviewRequestRef\.current/,
  );
  assert.match(
    installedBundle,
    /linkPreviewManualFieldsRef\.current\.has\(key\)/,
  );
  assert.match(
    installedBundle,
    /new URL\(url, "https:\/\/blog\.kanouk\.com"\)\.href/,
  );
  assert.match(installedBundle, /parsed\.protocol !== "https:"/);
  assert.match(
    installedBundle,
    /body: JSON\.stringify\(\{ url: previewUrl \}\)/,
  );
  assert.match(installedBundle, /linkPreviewRefreshNonce/);
  assert.match(installedBundle, /リンク情報を再取得/);
  assert.match(installedBundle, /isYohakuLinkCard/);
  assert.match(installedBundle, /referrerPolicy: "no-referrer"/);
  assert.match(installedBundle, /role: linkPreviewState\.status === "error" \? "alert" : "status"/);
  for (const utility of [
    "max-h-64",
    "max-h-48",
    "aspect-square",
    "grid-cols-2",
    "overflow-y-auto",
    "ring-kumo-brand\\/20",
    "border-kumo-brand\\/50",
  ]) {
    assert.ok(installedStyles.includes(`.${utility}`), `${utility} must exist in distributed CSS`);
  }
  assert.doesNotMatch(
    installedBundle,
    /mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3/,
  );
  assert.doesNotMatch(
    installedBundle,
    /border-kumo-brand ring-2 ring-kumo-brand\/30.*hover:border-kumo-brand\/60/,
  );
  assert.equal(patchEmDashRelatedMediaSource(installedBundle), installedBundle);
});

test("editor patch fails closed against an unknown upstream bundle", () => {
  assert.throws(
    () => patchEmDashRelatedMediaSource("function PluginBlockModal() {}"),
    /Review the EmDash admin bundle/,
  );
});
