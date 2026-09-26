import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderEmbedPreview, YohakuEmbedPreview } from "../plugins/yohaku-content-blocks/src/admin/embed-preview.mjs";
import { embedExtension } from "../plugins/yohaku-content-blocks/src/admin/block-editors.mjs";
import { yohakuPreviewValue } from "../plugins/yohaku-content-blocks/src/admin/link-preview-auto.mjs";

function previewTree(values, loaded = "") {
  return renderEmbedPreview({ values, loadedUrl: loaded, onLoad: () => {} });
}
const spotify = "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5";
test("editor preview keeps URL/caption and makes no iframe before explicit click", () => {
  const tree = previewTree({ id: spotify, display: "player", caption: "記事用キャプション" });
  assert.equal(tree.type, "figure");
  const source = JSON.stringify(tree);
  assert.ok(source.includes("Spotifyをプレビュー"));
  assert.ok(source.includes("記事用キャプション"));
  assert.ok(source.includes(spotify));
  assert.ok(!source.includes('"type":"iframe"'));
});
test("loaded editor player is allowlisted, sized, accessible and not autoplaying", () => {
  const tree = previewTree({ id: spotify, display: "player" }, "https://open.spotify.com/embed/episode/7makk4oTQel546B0PZlDM5");
  const frame = tree.props.children[0].props.children;
  assert.equal(frame.type, "iframe");
  assert.match(frame.props.src, /^https:\/\/open.spotify.com\/embed\//);
  assert.ok(frame.props.title);
  assert.equal(frame.props.style.width, "100%");
  assert.ok(!frame.props.allow.includes("autoplay"));
});
test("link-card choice renders metadata without loading a provider player", () => {
  const tree = previewTree({ id: spotify, display: "link-card", caption: "キャプション", linkPreviewAuto: { version: 1, url: spotify, title: "番組名", description: "番組の紹介", imageUrl: "https://example.com/cover.jpg" } });
  const source = JSON.stringify(tree);
  assert.ok(source.includes("番組名") && source.includes("番組の紹介"));
  assert.ok(!source.includes('"type":"iframe"'));
});
test("short and nonofficial URLs provide guidance instead of an unsafe preview", () => {
  for (const id of ["https://vm.tiktok.com/ABC/", "https://spotify.link/ABC"]) assert.match(JSON.stringify(previewTree({ id })), /短縮URL/);
  assert.match(JSON.stringify(previewTree({ id: "https://evil.example/player" })), /公式URLだけ/);
});
test("insert and edit dialogs and the inserted block share validation and the preview component", () => {
  const invalid = embedExtension.useModal({ block: { type: "yohaku.embed" }, formValues: { id: "https://evil.example/player" } });
  assert.equal(invalid.canSubmit, false);
  assert.equal(invalid.before.type, YohakuEmbedPreview);
  const valid = embedExtension.useModal({ block: { type: "yohaku.embed" }, formValues: { id: spotify, display: "player" } });
  assert.equal(valid.canSubmit, true);
  assert.deepEqual(valid.before.props.values, { id: spotify, display: "player" });
  assert.equal(embedExtension.useModal({ block: { type: "yohaku.linkCard" }, formValues: {} }), null);
  const node = embedExtension.nodeView({ blockType: "yohaku.embed", id: spotify, data: { display: "player", caption: "c" } });
  assert.equal(node.below.type, YohakuEmbedPreview);
  assert.deepEqual(node.below.props.values, { display: "player", caption: "c", id: spotify });
  assert.equal(embedExtension.nodeView({ blockType: "yohaku.photo", id: "x", data: {} }), null);
});

test("public link-card rendering retains the saved share URL and independent caption", async () => {
  const source = await readFile(new URL("../plugins/yohaku-content-blocks/src/astro/Embed.astro", import.meta.url), "utf8");
  assert.match(source, /const linkCardNode = \{ \.\.\.node, caption: "" \}/);
  assert.doesNotMatch(source, /id: parsed.canonicalUrl/);
  assert.match(source, /<LinkCard node=\{linkCardNode\} \/>[\s\S]*?<figcaption>/);
  const share = `${spotify}?si=tracking`;
  const values = { id: share, linkPreviewAuto: { version: 1, url: share, title: "Saved title" } };
  assert.equal(yohakuPreviewValue(values, "title"), "Saved title");
});
