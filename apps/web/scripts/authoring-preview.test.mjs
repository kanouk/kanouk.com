import assert from "node:assert/strict";
import test from "node:test";
import { yohakuPreviewUrl, yohakuPreviewValue, yohakuMergePreview } from "../plugins/yohaku-content-blocks/src/admin/link-preview-auto.mjs";

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
