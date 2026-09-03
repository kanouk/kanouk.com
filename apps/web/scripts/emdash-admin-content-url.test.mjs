import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  patchEmDashAdminSource,
  resolveContentUrl,
} from "./patch-emdash-admin-content-url.mjs";

const sourceFixture = `
function contentUrl(collection, slug, urlPattern) {
\tconst safe = slug.replace(LEADING_SLASHES, "");
\treturn urlPattern ? urlPattern.replace("{slug}", safe) : \`/\${collection}/\${safe}\`;
}
contentUrl(collection, slug || item.id, urlPattern)
contentUrl(collection, slug || item?.id || "", urlPattern)
contentUrl(collection, item.slug, urlPattern)
contentUrl(collection, item.slug, urlPattern)
`;

test("EmDash live-view URL uses the entry ID for an {id} pattern", () => {
  assert.equal(
    resolveContentUrl(
      "posts",
      "fukuoka-trip-2026-03",
      "/posts/{id}",
      "01M1CRQMF21R7TK33CH7XW60KH",
    ),
    "/posts/01M1CRQMF21R7TK33CH7XW60KH",
  );
});

test("slug patterns and the default collection route keep using the slug", () => {
  assert.equal(
    resolveContentUrl("posts", "/legacy%2Fslug", "/blog/{slug}", "/01ABC"),
    "/blog/legacy%2Fslug",
  );
  assert.equal(
    resolveContentUrl("pages", "/about", undefined, "/01ABC"),
    "/pages/about",
  );
});

test("admin bundle patch updates preview, live-view, and list links", () => {
  const patched = patchEmDashAdminSource(sourceFixture);

  assert.match(patched, /emdash-kanouk-content-url-id-support-v1/);
  assert.match(patched, /replaceAll\("\{id\}", safeId\)/);
  assert.equal(
    patched.split("contentUrl(collection, item.slug, urlPattern, item.id)")
      .length - 1,
    2,
  );
  assert.equal(patchEmDashAdminSource(patched), patched);
});

test("the installed EmDash admin bundle contains the live-view fix", async () => {
  const installedBundle = await readFile(
    new URL("../node_modules/@emdash-cms/admin/dist/index.js", import.meta.url),
    "utf8",
  );

  assert.match(installedBundle, /emdash-kanouk-content-url-id-support-v1/);
  assert.match(
    installedBundle,
    /contentUrl\(collection, item\.slug, urlPattern, item\.id\)/,
  );
});

test("admin bundle patch fails closed when the upstream bundle changes", () => {
  assert.throws(
    () => patchEmDashAdminSource("function contentUrl() {}"),
    /Review the EmDash admin bundle/,
  );
});
