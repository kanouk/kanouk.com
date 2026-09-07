import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { embedParserBrowserSource } from "../plugins/yohaku-content-blocks/src/embed-url.mjs";
import { YohakuEmbedPreview, upgradeEmbedPreview } from "./patch-emdash-embed-preview.mjs";
import { yohakuPreviewUrl, yohakuPreviewValue } from "./patch-emdash-authoring-preview.mjs";

function previewTree(values, loaded = "") {
  const context = vm.createContext({ URL, jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), React$1: { useState: () => [loaded, () => {}] }, values });
  vm.runInContext(`${embedParserBrowserSource()}\n${yohakuPreviewUrl.toString()}\n${yohakuPreviewValue.toString()}\n${YohakuEmbedPreview.toString()}`, context);
  return vm.runInContext("YohakuEmbedPreview({ values })", context);
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
test("native insert and edit use the same validation and preview component", async () => {
  const source = await readFile(new URL("../node_modules/@emdash-cms/admin/dist/index.js", import.meta.url), "utf8");
  assert.match(source, /emdash-kanouk-embed-preview-v9/);
  assert.match(source, /emdash-kanouk-embed-preview-status-v10/);
  assert.match(source, /parseEmbedUrl\(formValues.id\).ok\)\) && linkPreviewState.message/);
  assert.match(source, /const canSubmit = block\?\.type === "yohaku.embed" \? parseEmbedUrl\(formValues.id\).ok/);
  assert.match(source, /if \(block\?\.type === "yohaku.embed" && !parseEmbedUrl\(formValues.id\).ok\) return/);
  assert.match(source, /jsx\(YohakuEmbedPreview, \{ values: formValues \}\)/);
  assert.match(source, /values: \{ \.\.\.data, id \}/);
  assert.equal(upgradeEmbedPreview(source), source);
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
