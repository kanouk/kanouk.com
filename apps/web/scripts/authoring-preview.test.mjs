import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { yohakuPreviewUrl, yohakuPreviewValue, yohakuMergePreview, upgradeAuthoringPreview } from "./patch-emdash-authoring-preview.mjs";

const preview = { title: "自動タイトル", description: "自動説明", imageUrl: "https://example.com/image.jpg", fetchedAt: "2026-09-07T00:00:00.000Z" };
test("view metadata is separate from manual fields and survives JSON roundtrip", () => {
  const saved = JSON.parse(JSON.stringify(yohakuMergePreview({ id: "https://example.com/#fragment" }, preview, "https://example.com/")));
  assert.equal(saved.title, undefined);
  assert.equal(saved.description, undefined);
  assert.equal(saved.imageUrl, undefined);
  assert.equal(saved.linkPreviewAuto.version, 1);
  assert.equal(saved.linkPreviewAuto.url, "https://example.com/");
  assert.equal(yohakuPreviewValue(saved, "title"), preview.title);
});
test("legacy and newly edited manual values always win, including pending request races", () => {
  const saved = yohakuMergePreview({ id: "https://example.com/", title: "手動タイトル", description: "手動説明" }, preview, "https://example.com/");
  assert.equal(saved.title, "手動タイトル");
  assert.equal(yohakuPreviewValue(saved, "title"), "手動タイトル");
  assert.equal(yohakuPreviewValue(saved, "description"), "手動説明");
  assert.equal(yohakuPreviewValue({ ...saved, title: "" }, "title"), preview.title);
});
test("changed URLs reject stale responses and never reuse another URL snapshot", () => {
  const saved = yohakuMergePreview({ id: "https://example.com/", title: "手動" }, preview, "https://example.com/");
  const changed = { ...saved, id: "https://other.example/", title: "" };
  assert.equal(yohakuPreviewValue(changed, "imageUrl"), "");
  assert.equal(yohakuMergePreview(changed, preview, "https://example.com/"), changed);
  assert.equal(yohakuPreviewValue({ ...saved, id: "bad URL", title: "" }, "title"), "");
});
test("relative paths normalize to blog canonical origin and invalid schemes fail closed", () => {
  assert.equal(yohakuPreviewUrl("/posts/example#top"), "https://blog.kanouk.com/posts/example");
  for (const url of ["", "javascript:alert(1)", "http://example.com/", "https://user:secret@example.com/"]) assert.equal(yohakuPreviewUrl(url), "");
});
test("installed preview patch is idempotent and valid JavaScript", async () => {
  const source = await readFile(new URL("../node_modules/@emdash-cms/admin/dist/index.js", import.meta.url), "utf8");
  assert.match(source, /emdash-kanouk-authoring-preview-v8/);
  assert.match(source, /return yohakuMergePreview\(next, preview, previewUrl\)/);
  assert.doesNotMatch(source, /next\[key\] = preview\[key\]/);
  assert.equal(upgradeAuthoringPreview(source), source);
  // Parse as a module without evaluating its browser-only imports.
  const ts = await import("typescript");
  const diagnostics = ts.default.createSourceFile("admin.js", source, ts.default.ScriptTarget.Latest, false, ts.default.ScriptKind.JS).parseDiagnostics;
  assert.deepEqual(diagnostics, []);
});
test("injected helpers are self-contained browser functions", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(`${yohakuPreviewUrl.toString()}\n${yohakuPreviewValue.toString()}\n${yohakuMergePreview.toString()}`, context);
  assert.equal(vm.runInContext('yohakuPreviewUrl("/posts/test")', context), "https://blog.kanouk.com/posts/test");
});
