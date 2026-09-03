import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEADING_SLASHES = /^\/+/;
const PATCH_MARKER = "emdash-kanouk-content-url-id-support-v1";

const ORIGINAL_CONTENT_URL = `function contentUrl(collection, slug, urlPattern) {
\tconst safe = slug.replace(LEADING_SLASHES, "");
\treturn urlPattern ? urlPattern.replace("{slug}", safe) : \`/\${collection}/\${safe}\`;
}`;

function patchedContentUrlSource() {
  return `/* ${PATCH_MARKER} */\n${resolveContentUrl
    .toString()
    .replace("resolveContentUrl", "contentUrl")}`;
}

function replaceExactly(source, before, after, expectedCount) {
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} occurrence(s) of ${JSON.stringify(before)}, found ${count}. ` +
        "Review the EmDash admin bundle before updating the patch.",
    );
  }
  return source.split(before).join(after);
}

export function resolveContentUrl(collection, slug, urlPattern, id = slug) {
  const safeSlug = slug.replace(LEADING_SLASHES, "");
  const safeId = id.replace(LEADING_SLASHES, "");
  return urlPattern
    ? urlPattern.replaceAll("{slug}", safeSlug).replaceAll("{id}", safeId)
    : `/${collection}/${safeSlug}`;
}

export function patchEmDashAdminSource(source) {
  if (source.includes(PATCH_MARKER)) return source;

  let patched = replaceExactly(
    source,
    ORIGINAL_CONTENT_URL,
    patchedContentUrlSource(),
    1,
  );
  patched = replaceExactly(
    patched,
    "contentUrl(collection, slug || item.id, urlPattern)",
    "contentUrl(collection, slug || item.id, urlPattern, item.id)",
    1,
  );
  patched = replaceExactly(
    patched,
    'contentUrl(collection, slug || item?.id || "", urlPattern)',
    'contentUrl(collection, slug || item?.id || "", urlPattern, item?.id || slug || "")',
    1,
  );
  patched = replaceExactly(
    patched,
    "contentUrl(collection, item.slug, urlPattern)",
    "contentUrl(collection, item.slug, urlPattern, item.id)",
    2,
  );
  return patched;
}

async function patchInstalledAdmin() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageDirectory = path.resolve(
    scriptDirectory,
    "../node_modules/@emdash-cms/admin",
  );
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const bundlePath = path.join(packageDirectory, "dist/index.js");
  const [{ version }, source] = await Promise.all([
    readFile(packageJsonPath, "utf8").then(JSON.parse),
    readFile(bundlePath, "utf8"),
  ]);
  const patched = patchEmDashAdminSource(source);

  if (patched === source) {
    console.log(`@emdash-cms/admin ${version}: live-view URL patch already applied`);
    return;
  }

  await writeFile(bundlePath, patched);
  console.log(`@emdash-cms/admin ${version}: patched live-view {id} URL support`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (invokedPath === import.meta.url) {
  await patchInstalledAdmin();
}
