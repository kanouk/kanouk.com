import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { adminPackagePaths, PATCH_MARKER, patchAdminSource } from "./emdash-admin/apply.mjs";
import { AdminPatchError, createEditor } from "./emdash-admin/patch-kit.mjs";
import blockEditorRuntime, { RUNTIME_MARKER } from "./emdash-admin/patches/block-editor-runtime.mjs";
import { adminPatches, VERIFIED_ADMIN_VERSION } from "./emdash-admin/registry.mjs";

const paths = adminPackagePaths();
const read = (file) => readFile(file, "utf8");

test("the installed admin is the verified version, patched from its pristine bundle", async () => {
  const [{ version }, installed, pristine] = await Promise.all([
    read(paths.packageJson).then(JSON.parse),
    read(paths.bundle),
    read(paths.pristine),
  ]);
  assert.equal(version, VERIFIED_ADMIN_VERSION);
  assert.ok(!pristine.includes(PATCH_MARKER));
  assert.equal(installed, patchAdminSource(pristine));
  for (const patch of adminPatches) assert.ok(installed.startsWith(`/* ${PATCH_MARKER}:`) && installed.split("\n", 1)[0].includes(patch.id));
});

test("the patched bundle is valid JavaScript", async () => {
  const ts = await import("typescript");
  const source = await read(paths.bundle);
  const file = ts.default.createSourceFile("admin.js", source, ts.default.ScriptTarget.Latest, false, ts.default.ScriptKind.JS);
  assert.deepEqual(file.parseDiagnostics, []);
});

test("every extension point documents itself and fails closed on unknown upstream code", () => {
  const ids = new Set();
  for (const patch of adminPatches) {
    assert.match(patch.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(patch.id), `duplicate ${patch.id}`);
    ids.add(patch.id);
    assert.ok(patch.summary && patch.upstream, `${patch.id} needs summary and upstream notes`);
    assert.throws(() => patch.apply(createEditor(patch.id, "function unrelated() {}")), (error) => error instanceof AdminPatchError && error.patchId === patch.id);
  }
});

test("patching refuses an already patched bundle", async () => {
  assert.throws(() => patchAdminSource(`/* ${PATCH_MARKER}: x */`), /already patched/);
});

test("upstream now resolves {id} URL patterns for preview, live view and list links", async () => {
  const pristine = await read(paths.pristine);
  const start = pristine.indexOf("const DATE_TOKEN$1 =");
  const end = pristine.indexOf("/** Matches http:// or https:// URLs */");
  const context = vm.createContext({ LEADING_SLASHES: /^\/+/ });
  vm.runInContext(`${pristine.slice(start, end)}\nglobalThis.contentUrl = contentUrl;`, context);
  const options = { id: "01M1CRQMF21R7TK33CH7XW60KH", locale: "ja", i18n: { defaultLocale: "ja" } };
  assert.equal(context.contentUrl("posts", "fukuoka-trip-2026-03", "/posts/{id}", options), "/posts/01M1CRQMF21R7TK33CH7XW60KH");
  assert.equal(context.contentUrl("photos", "/legacy-slug", "/p/{slug}", options), "/p/legacy-slug");
  assert.equal(context.contentUrl("pages", "/about", undefined, options), "/pages/about");
  // Every caller passes the entry ID, so the old local contentUrl patch is gone.
  const calls = [...pristine.matchAll(/contentUrl\([^)]*urlPattern, \{([^}]*)\}/g)];
  assert.ok(calls.length >= 5);
  for (const [, options] of calls) assert.match(options, /\bid: item\??\.id\b/);
});

function runtimeContext(pluginAdmins) {
  const editor = createEditor("test", "function getPluginBlockDefaultValues(fields) {}\nfunction usePluginAdmins() {}\nimport * as React$1 from \"react\";");
  blockEditorRuntime.apply(editor);
  const runtime = editor.source.slice(0, editor.source.indexOf("function getPluginBlockDefaultValues"));
  const context = vm.createContext({ usePluginAdmins: () => pluginAdmins, React$1: { useMemo: (fn) => fn() } });
  vm.runInContext(runtime, context);
  return context;
}

test("block editor runtime collects plugin extensions in a stable order and merges their answers", () => {
  const calls = [];
  const context = runtimeContext({
    zeta: { blockEditorExtensions: [{ id: "z", insertDefaults: () => ({ fromZ: 1 }), nodeView: () => ({ title: "Z", imageUrl: "z.jpg" }) }] },
    alpha: { blockEditorExtensions: [{ id: "a", insertDefaults: (ctx) => { calls.push(ctx); return { fromA: 1 }; }, nodeView: () => ({ title: "", externalUrl: "https://a" }) }] },
    other: { fields: {} },
  });
  const extensions = vm.runInContext("useBlockEditorExtensions()", context);
  assert.deepEqual(Array.from(extensions, (extension) => `${extension.pluginId}:${extension.id}`), ["alpha:a", "zeta:z"]);
  context.extensions = extensions;
  const defaults = vm.runInContext("resolveBlockInsertDefaults(extensions, { block: { type: 'x' } })", context);
  assert.deepEqual({ ...defaults }, { fromA: 1, fromZ: 1 });
  assert.equal(calls[0].block.type, "x");
  const view = vm.runInContext("resolveBlockNodeView(extensions, {})", context);
  assert.deepEqual({ ...view }, { externalUrl: "https://a", title: "Z", imageUrl: "z.jpg" });
});

test("without plugin extensions the block editor behaves like upstream", () => {
  const context = runtimeContext({});
  context.extensions = vm.runInContext("useBlockEditorExtensions()", context);
  assert.equal(vm.runInContext("extensions.length", context), 0);
  assert.equal(vm.runInContext("resolveBlockInsertDefaults(extensions, {})", context), undefined);
  assert.deepEqual({ ...vm.runInContext("resolveBlockNodeView(extensions, {})", context) }, {});
});

test("the installed bundle wires each extension point where upstream renders it", async () => {
  const source = await read(paths.bundle);
  assert.ok(source.includes(RUNTIME_MARKER));
  // Block dialog: plugin hooks, submit gate, field transforms, before/after slots and select addons.
  assert.match(source, /function PluginBlockModal\(\{ block, initialValues, defaultValues, onClose, onInsert \}\)/);
  assert.match(source, /extension\.useModal \? extension\.useModal\(\{/);
  assert.match(source, /if \(!extensionAllowsSubmit\) return;/);
  assert.match(source, /field: transformBlockField\(field\)/);
  assert.match(source, /renderFieldAddon\(\{ field, options, value, select: selectOption \}\)/);
  // Hooks run after the dialog's reset effect so their effects keep that order.
  const modal = source.slice(source.indexOf("function PluginBlockModal("), source.indexOf("\nfunction BlockKitField("));
  assert.ok(modal.indexOf("}, [block, initialValues, defaultValues]);") < modal.indexOf("const blockModalContributions ="));
  // Dependent selects.
  assert.match(source, /body: JSON\.stringify\(\{ values: formValues \?\? \{\} \}\)/);
  assert.match(source, /selectedOption\?\.values/);
  // Insert defaults with the entry draft.
  assert.match(source, /documentData: formData,/);
  assert.match(source, /resolveBlockInsertDefaults\(blockInsertExtensionsRef\.current/);
  // Node view summary.
  assert.match(source, /navigator\.clipboard\.writeText\(blockExternalUrl\)/);
  assert.match(source, /blockNodeView\.below \?/);
  // Editor panels on new entries with draft access.
  assert.match(source, /extension\.supportsNew === true/);
  assert.match(source, /draftData: formData,\n\t*onDraftFieldChange: handleFieldChange/);
});
