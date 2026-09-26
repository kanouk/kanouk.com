// Applies the EmDash admin extension points to the installed admin bundle.
//
//   node scripts/emdash-admin/apply.mjs          patch node_modules (postinstall)
//   node scripts/emdash-admin/apply.mjs --check  verify only, write nothing
//
// The untouched upstream bundle is kept next to it as `index.js.pristine`, so
// re-running after editing a patch always starts from upstream code.

import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEditor } from "./patch-kit.mjs";
import { adminPatches, VERIFIED_ADMIN_VERSION } from "./registry.mjs";

export const PATCH_MARKER = "emdash-admin-extension-points";

export function patchAdminSource(source, patches = adminPatches) {
  if (source.includes(PATCH_MARKER)) {
    throw new Error(`[emdash-admin] The bundle is already patched; start from the pristine upstream bundle.`);
  }
  let current = source;
  for (const patch of patches) {
    const editor = createEditor(patch.id, current);
    patch.apply(editor);
    current = editor.source;
  }
  return `/* ${PATCH_MARKER}: ${patches.map((patch) => patch.id).join(", ")} */\n${current}`;
}

export function adminPackagePaths(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")) {
  const packageDirectory = path.join(root, "node_modules/@emdash-cms/admin");
  const bundle = path.join(packageDirectory, "dist/index.js");
  return { packageJson: path.join(packageDirectory, "package.json"), bundle, pristine: `${bundle}.pristine` };
}

async function readPristine(paths) {
  const installed = await readFile(paths.bundle, "utf8");
  // A fresh install replaced the bundle: it is the new pristine source.
  if (!installed.includes(PATCH_MARKER)) {
    await copyFile(paths.bundle, paths.pristine);
    return installed;
  }
  return readFile(paths.pristine, "utf8");
}

async function main(argv) {
  const check = argv.includes("--check");
  const paths = adminPackagePaths();
  const { version } = JSON.parse(await readFile(paths.packageJson, "utf8"));
  if (version !== VERIFIED_ADMIN_VERSION) {
    console.warn(`@emdash-cms/admin ${version}: extension points were verified against ${VERIFIED_ADMIN_VERSION}; review docs/emdash-upgrade.md.`);
  }
  const pristine = check
    ? await readFile(paths.bundle, "utf8").then((installed) => installed.includes(PATCH_MARKER) ? readFile(paths.pristine, "utf8") : installed)
    : await readPristine(paths);
  const patched = patchAdminSource(pristine);
  if (check) {
    console.log(`@emdash-cms/admin ${version}: all ${adminPatches.length} extension points apply cleanly`);
    return;
  }
  const installed = await readFile(paths.bundle, "utf8");
  if (installed === patched) {
    console.log(`@emdash-cms/admin ${version}: extension points already applied`);
    return;
  }
  await writeFile(paths.bundle, patched);
  console.log(`@emdash-cms/admin ${version}: applied ${adminPatches.map((patch) => patch.id).join(", ")}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
