import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PATCH_MARKER = "emdash-kanouk-related-media-picker-v1";
const VISUAL_PICKER_MARKER = "emdash-kanouk-related-media-visual-picker-v2";
const DISTRIBUTED_CSS_MARKER = "emdash-kanouk-related-media-distributed-css-v3";

function replaceExactly(source, before, after, expectedCount = 1) {
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} occurrence(s) of ${JSON.stringify(before)}, found ${count}. ` +
        "Review the EmDash admin bundle before updating the related-media patch.",
    );
  }
  return source.split(before).join(after);
}

const ORIGINAL_DYNAMIC_SELECT = `function DynamicSelect({ field, pluginId, value, onChange }) {
\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);
\tconst [loading, setLoading] = React$1.useState(false);
\tconst { _: _t5 } = useLingui();
\tReact$1.useEffect(() => {
\t\tif (!field.optionsRoute || !pluginId) return;
\t\tconst controller = new AbortController();
\t\tsetLoading(true);
\t\t(async () => {
\t\t\ttry {
\t\t\t\tconst res = await fetch(\`/_emdash/api/plugins/\${pluginId}/\${field.optionsRoute}\`, {
\t\t\t\t\tmethod: "POST",
\t\t\t\t\theaders: {
\t\t\t\t\t\t"Content-Type": "application/json",
\t\t\t\t\t\t"X-EmDash-Request": "1"
\t\t\t\t\t},
\t\t\t\t\tbody: JSON.stringify({}),
\t\t\t\t\tsignal: controller.signal
\t\t\t\t});
\t\t\t\tif (res.ok) {
\t\t\t\t\tconst body = await res.json();
\t\t\t\t\tif (body.data?.items) setDynamicOptions(body.data.items.map((item) => ({
\t\t\t\t\t\tlabel: item.name,
\t\t\t\t\t\tvalue: item.id
\t\t\t\t\t})));
\t\t\t\t}
\t\t\t} catch {} finally {
\t\t\t\tif (!controller.signal.aborted) setLoading(false);
\t\t\t}
\t\t})();
\t\treturn () => controller.abort();
\t}, [field.optionsRoute, pluginId]);
\tconst options = dynamicOptions ?? field.options;
\treturn /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("label", {
\t\tclassName: "text-sm font-medium mb-1.5 block",
\t\tchildren: field.label
\t}), loading ? /* @__PURE__ */ jsx("div", {
\t\tclassName: "flex h-10 items-center px-3 text-sm text-kumo-subtle",
\t\tchildren: _t5({
\t\t\tid: "Z3FXyt",
\t\t\tmessage: "Loading..."
\t\t})
\t}) : /* @__PURE__ */ jsx(Select, {
\t\t"aria-label": field.label,
\t\tvalue: typeof value === "string" ? value : "",
\t\tonValueChange: (v) => onChange(field.action_id, v ?? ""),
\t\titems: {
\t\t\t"": _t5({
\t\t\t\tid: "O/7I0o",
\t\t\t\tmessage: "Select..."
\t\t\t}),
\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
\t\t}
\t})] });
}`;

const PATCHED_DYNAMIC_SELECT = `function DynamicSelect({ field, pluginId, value, onChange, formValues, onPatch }) {
\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);
\tconst [loading, setLoading] = React$1.useState(false);
\tconst { _: _t5 } = useLingui();
\tconst dependencyValues = JSON.stringify((field.depends_on ?? []).map((key) => formValues?.[key] ?? null));
\tconst previousDependencies = React$1.useRef(null);
\tReact$1.useEffect(() => {
\t\tif (previousDependencies.current !== null && previousDependencies.current !== dependencyValues) {
\t\t\tonChange(field.action_id, "");
\t\t\tif (Array.isArray(field.clear_fields)) onPatch(Object.fromEntries(field.clear_fields.map((key) => [key, ""])));
\t\t}
\t\tpreviousDependencies.current = dependencyValues;
\t}, [dependencyValues]);
\tReact$1.useEffect(() => {
\t\tif (!field.optionsRoute || !pluginId) return;
\t\tif ((field.depends_on ?? []).some((key) => !formValues?.[key])) {
\t\t\tsetDynamicOptions([]);
\t\t\treturn;
\t\t}
\t\tconst controller = new AbortController();
\t\tsetLoading(true);
\t\t(async () => {
\t\t\ttry {
\t\t\t\tconst res = await fetch(\`/_emdash/api/plugins/\${pluginId}/\${field.optionsRoute}\`, {
\t\t\t\t\tmethod: "POST",
\t\t\t\t\theaders: {
\t\t\t\t\t\t"Content-Type": "application/json",
\t\t\t\t\t\t"X-EmDash-Request": "1"
\t\t\t\t\t},
\t\t\t\t\tbody: JSON.stringify({ values: formValues ?? {} }),
\t\t\t\t\tsignal: controller.signal
\t\t\t\t});
\t\t\t\tif (res.ok) {
\t\t\t\t\tconst body = await res.json();
\t\t\t\t\tif (body.data?.items) setDynamicOptions(body.data.items.map((item) => ({
\t\t\t\t\t\tlabel: item.name,
\t\t\t\t\t\tvalue: item.id,
\t\t\t\t\t\tvalues: item.values
\t\t\t\t\t})));
\t\t\t\t}
\t\t\t} catch {} finally {
\t\t\t\tif (!controller.signal.aborted) setLoading(false);
\t\t\t}
\t\t})();
\t\treturn () => controller.abort();
\t}, [field.optionsRoute, pluginId, dependencyValues]);
\tconst options = dynamicOptions ?? field.options;
\treturn /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("label", {
\t\tclassName: "text-sm font-medium mb-1.5 block",
\t\tchildren: field.label
\t}), loading ? /* @__PURE__ */ jsx("div", {
\t\tclassName: "flex h-10 items-center px-3 text-sm text-kumo-subtle",
\t\tchildren: _t5({
\t\t\tid: "Z3FXyt",
\t\t\tmessage: "Loading..."
\t\t})
\t}) : /* @__PURE__ */ jsx(Select, {
\t\t"aria-label": field.label,
\t\tvalue: typeof value === "string" ? value : "",
\t\tonValueChange: (v) => {
\t\t\tconst nextValue = v ?? "";
\t\t\tonChange(field.action_id, nextValue);
\t\t\tconst selected = options.find((option) => option.value === nextValue);
\t\t\tif (selected?.values && typeof selected.values === "object") onPatch(selected.values);
\t\t},
\t\titems: {
\t\t\t"": _t5({
\t\t\t\tid: "O/7I0o",
\t\t\t\tmessage: "Select..."
\t\t\t}),
\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
\t\t}
\t})] });
}`;

function upgradeRelatedMediaVisualPicker(source) {
  let patched = replaceExactly(
    source,
    "function DynamicSelect({ field, pluginId, value, onChange, formValues, onPatch }) {\n\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);\n\tconst [loading, setLoading] = React$1.useState(false);",
    `/* ${VISUAL_PICKER_MARKER} */\nfunction DynamicSelect({ field, pluginId, value, onChange, formValues, onPatch }) {\n\tconst [dynamicOptions, setDynamicOptions] = React$1.useState(null);\n\tconst [loading, setLoading] = React$1.useState(false);\n\tconst [error, setError] = React$1.useState("");`,
  );
  patched = replaceExactly(
    patched,
    "\t\tconst controller = new AbortController();\n\t\tsetLoading(true);",
    "\t\tconst controller = new AbortController();\n\t\tsetError(\"\");\n\t\tsetLoading(true);",
  );
  patched = replaceExactly(
    patched,
    "\t\t\t\tif (res.ok) {\n\t\t\t\t\tconst body = await res.json();",
    "\t\t\t\tif (!res.ok) throw new Error(`写真を読み込めませんでした（${res.status}）`);\n\t\t\t\tif (res.ok) {\n\t\t\t\t\tconst body = await res.json();",
  );
  patched = replaceExactly(
    patched,
    "\t\t\t} catch {} finally {\n\t\t\t\tif (!controller.signal.aborted) setLoading(false);",
    "\t\t\t} catch (cause) {\n\t\t\t\tif (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : \"写真を読み込めませんでした。\");\n\t\t\t} finally {\n\t\t\t\tif (!controller.signal.aborted) setLoading(false);",
  );
  patched = replaceExactly(
    patched,
    "\tconst options = dynamicOptions ?? field.options;\n\treturn /* @__PURE__ */ jsxs(\"div\", { children:",
    `\tconst options = dynamicOptions ?? field.options;
\tconst selectOption = (nextValue) => {
\t\tonChange(field.action_id, nextValue);
\t\tconst selectedOption = options.find((option) => option.value === nextValue);
\t\tif (selectedOption?.values && typeof selectedOption.values === "object") onPatch(selectedOption.values);
\t};
\tconst photoOptions = field.optionsRoute === "photos/options" ? options.filter((option) => typeof option.values?.imageUrl === "string" && option.values.imageUrl.length > 0) : [];
\treturn /* @__PURE__ */ jsxs("div", { children:`,
  );
  patched = replaceExactly(
    patched,
    `\t\tonValueChange: (v) => {
\t\t\tconst nextValue = v ?? "";
\t\t\tonChange(field.action_id, nextValue);
\t\t\tconst selected = options.find((option) => option.value === nextValue);
\t\t\tif (selected?.values && typeof selected.values === "object") onPatch(selected.values);
\t\t},`,
    `\t\tonValueChange: (v) => selectOption(v ?? ""),`,
  );
  patched = replaceExactly(
    patched,
    `\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
\t\t}
\t})] });
}`,
    `\t\t\t...Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
\t\t}
\t}), error ? /* @__PURE__ */ jsx("p", {
\t\trole: "alert",
\t\tclassName: "mt-2 text-sm text-kumo-danger",
\t\tchildren: error
\t}) : null, photoOptions.length > 0 ? /* @__PURE__ */ jsx("div", {
\t\trole: "listbox",
\t\t"aria-label": "写真をサムネイルから選択",
\t\tclassName: "mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3",
\t\tchildren: photoOptions.map((option) => /* @__PURE__ */ jsxs("button", {
\t\t\ttype: "button",
\t\t\trole: "option",
\t\t\t"aria-selected": value === option.value,
\t\t\tonClick: () => selectOption(option.value),
\t\t\tclassName: value === option.value ? "overflow-hidden rounded-md border border-kumo-brand ring-2 ring-kumo-brand/30" : "overflow-hidden rounded-md border border-kumo-line hover:border-kumo-brand/60",
\t\t\tchildren: [/* @__PURE__ */ jsx("img", {
\t\t\t\tsrc: option.values.imageUrl,
\t\t\t\talt: "",
\t\t\t\tloading: "lazy",
\t\t\t\tclassName: "aspect-square w-full bg-kumo-tint object-cover"
\t\t\t}), /* @__PURE__ */ jsx("span", {
\t\t\t\tclassName: "block truncate p-2 text-xs",
\t\t\t\tchildren: \`写真 \${option.label} を選択\`
\t\t\t})]
\t\t}, option.value))
\t}) : null] });
}`,
  );
  patched = replaceExactly(
    patched,
    "\tconst hasFields = blockDef?.fields && blockDef.fields.length > 0;",
    `\tconst hasFields = blockDef?.fields && blockDef.fields.length > 0;
\tconst isYohakuPhoto = blockType === "yohaku.photo";
\tconst isYohakuAlbum = blockType === "yohaku.album";
\tconst mediaImageUrl = isYohakuPhoto && typeof data.imageUrl === "string" ? data.imageUrl : "";
\tconst mediaTitle = isYohakuAlbum && typeof data.albumTitleSnapshot === "string" ? data.albumTitleSnapshot : isYohakuPhoto && typeof data.caption === "string" && data.caption ? data.caption : isYohakuPhoto && typeof data.alt === "string" ? data.alt : "";
\tconst localMediaOrigin = ["localhost", "127.0.0.1"].includes(window.location.hostname) || window.location.hostname.endsWith(".workers.dev") ? window.location.origin : "https://photos.kanouk.com";
\tconst publicMediaUrl = id && isYohakuPhoto ? \`\${localMediaOrigin}/p/\${encodeURIComponent(id)}\` : id && isYohakuAlbum ? \`\${localMediaOrigin}/albums/\${encodeURIComponent(id)}\` : id;`,
  );
  patched = replaceExactly(
    patched,
    "\t\tnavigator.clipboard.writeText(id);\n\t};\n\tconst handleOpenExternal = () => {\n\t\twindow.open(id, \"_blank\", \"noopener,noreferrer\");",
    "\t\tnavigator.clipboard.writeText(publicMediaUrl);\n\t};\n\tconst handleOpenExternal = () => {\n\t\twindow.open(publicMediaUrl, \"_blank\", \"noopener,noreferrer\");",
  );
  patched = replaceExactly(
    patched,
    "\tconst displayId = id ? getDisplayId(id, blockType) : Object.values(data).filter((v) => typeof v === \"string\" && v.length > 0).join(\", \") || blockType;",
    "\tconst displayId = mediaTitle || (id ? getDisplayId(id, blockType) : Object.values(data).filter((v) => typeof v === \"string\" && v.length > 0).join(\", \") || blockType);",
  );
  patched = replaceExactly(
    patched,
    `\t\t\t\t\t\t\tclassName: cn("flex-shrink-0 w-10 h-10 rounded-lg bg-kumo-tint flex items-center justify-center", color),
\t\t\t\t\t\t\tchildren: /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" })`,
    `\t\t\t\t\t\t\tclassName: cn("flex-shrink-0 w-10 h-10 overflow-hidden rounded-lg bg-kumo-tint flex items-center justify-center", color),
\t\t\t\t\t\t\tchildren: mediaImageUrl ? /* @__PURE__ */ jsx("img", {
\t\t\t\t\t\t\t\tsrc: mediaImageUrl,
\t\t\t\t\t\t\t\talt: "",
\t\t\t\t\t\t\t\tclassName: "h-full w-full object-cover"
\t\t\t\t\t\t\t}) : /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" })`,
  );
  return patched;
}

function upgradeForDistributedAdminCss(source) {
  let patched = replaceExactly(
    source,
    `/* ${VISUAL_PICKER_MARKER} */`,
    `/* ${DISTRIBUTED_CSS_MARKER} */`,
  );
  patched = replaceExactly(
    patched,
    'className: "mt-3 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3"',
    'className: "mt-3 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto"',
  );
  patched = replaceExactly(
    patched,
    '"overflow-hidden rounded-md border border-kumo-brand ring-2 ring-kumo-brand/30" : "overflow-hidden rounded-md border border-kumo-line hover:border-kumo-brand/60"',
    '"overflow-hidden rounded-md border border-kumo-brand ring-2 ring-kumo-brand/20" : "overflow-hidden rounded-md border border-kumo-line hover:border-kumo-brand/50"',
  );
  patched = replaceExactly(
    patched,
    '\tconst publicMediaUrl = id && isYohakuPhoto ? `${localMediaOrigin}/p/${encodeURIComponent(id)}` : id && isYohakuAlbum ? `${localMediaOrigin}/albums/${encodeURIComponent(id)}` : id;',
    '\tconst photoPublicKey = typeof data.photoSlug === "string" && data.photoSlug ? data.photoSlug : id;\n\tconst albumPublicKey = typeof data.albumSlug === "string" && data.albumSlug ? data.albumSlug : id;\n\tconst publicMediaUrl = id && isYohakuPhoto ? `${localMediaOrigin}/p/${encodeURIComponent(photoPublicKey)}` : id && isYohakuAlbum ? `${localMediaOrigin}/albums/${encodeURIComponent(albumPublicKey)}` : id;',
  );
  return patched;
}

export function patchEmDashRelatedMediaSource(source) {
  if (source.includes(DISTRIBUTED_CSS_MARKER)) return source;
  if (source.includes(VISUAL_PICKER_MARKER)) return upgradeForDistributedAdminCss(source);
  if (source.includes(PATCH_MARKER)) {
    return upgradeForDistributedAdminCss(upgradeRelatedMediaVisualPicker(source));
  }

  let patched = replaceExactly(
    source,
    "function getPluginBlockDefaultValues(fields) {",
    `/* ${PATCH_MARKER} */\nfunction findRelatedAlbumId(editor, beforePos) {\n\tlet preceding = \"\";\n\tlet first = \"\";\n\teditor.state.doc.descendants((node, pos) => {\n\t\tif (node.type.name !== \"pluginBlock\" || node.attrs?.blockType !== \"yohaku.album\") return;\n\t\tconst id = typeof node.attrs.id === \"string\" ? node.attrs.id.trim() : \"\";\n\t\tif (!id) return;\n\t\tif (!first) first = id;\n\t\tif (pos < beforePos) preceding = id;\n\t});\n\treturn preceding || first;\n}\nfunction getPluginBlockDefaultValues(fields) {`,
  );
  patched = replaceExactly(
    patched,
    "function PluginBlockModal({ block, initialValues, onClose, onInsert }) {",
    "function PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {",
  );
  patched = replaceExactly(
    patched,
    "setFormValues(buildPluginBlockFormValues(block, initialValues));",
    "setFormValues(buildPluginBlockFormValues(block, initialValues ?? defaultValues));",
  );
  patched = replaceExactly(
    patched,
    "}, [block, initialValues]);",
    "}, [block, initialValues, defaultValues]);",
  );
  patched = replaceExactly(
    patched,
    `\tconst handleFieldChange = (actionId, value) => {
\t\tsetFormValues((prev) => ({
\t\t\t...prev,
\t\t\t[actionId]: value
\t\t}));
\t};`,
    `\tconst handleFieldChange = (actionId, value) => {
\t\tsetFormValues((prev) => ({
\t\t\t...prev,
\t\t\t[actionId]: value
\t\t}));
\t};
\tconst handleFormPatch = (values) => {
\t\tsetFormValues((prev) => ({ ...prev, ...values }));
\t};`,
  );
  patched = replaceExactly(
    patched,
    `\t\t\t\t\t\tfield,
\t\t\t\t\t\tpluginId: block.pluginId,
\t\t\t\t\t\tvalue: formValues[field.action_id],
\t\t\t\t\t\tonChange: handleFieldChange`,
    `\t\t\t\t\t\tfield,
\t\t\t\t\t\tpluginId: block.pluginId,
\t\t\t\t\t\tvalue: formValues[field.action_id],
\t\t\t\t\t\tformValues,
\t\t\t\t\t\tonPatch: handleFormPatch,
\t\t\t\t\t\tonChange: handleFieldChange`,
  );
  patched = replaceExactly(
    patched,
    "function BlockKitField({ field, pluginId, value, onChange }) {",
    "function BlockKitField({ field, pluginId, value, onChange, formValues, onPatch = () => {} }) {",
  );
  patched = replaceExactly(
    patched,
    `\t\tcase "select": return /* @__PURE__ */ jsx(DynamicSelect, {
\t\t\tfield,
\t\t\tpluginId,
\t\t\tvalue,
\t\t\tonChange
\t\t});`,
    `\t\tcase "select": return /* @__PURE__ */ jsx(DynamicSelect, {
\t\t\tfield,
\t\t\tpluginId,
\t\t\tvalue,
\t\t\tonChange,
\t\t\tformValues,
\t\t\tonPatch
\t\t});`,
  );
  patched = replaceExactly(
    patched,
    ORIGINAL_DYNAMIC_SELECT,
    PATCHED_DYNAMIC_SELECT,
  );
  patched = replaceExactly(
    patched,
    "const [pluginBlockInitialValues, setPluginBlockInitialValues] = React$1.useState(void 0);",
    "const [pluginBlockInitialValues, setPluginBlockInitialValues] = React$1.useState(void 0);\n\tconst [pluginBlockDefaultValues, setPluginBlockDefaultValues] = React$1.useState(void 0);",
  );
  patched = replaceExactly(
    patched,
    `\t\t\tcommand: ({ editor, range }) => {
\t\t\t\teditor.chain().focus().deleteRange(range).run();
\t\t\t\tsetPluginBlockModal(block);
\t\t\t}
\t\t});`,
    `\t\t\tcommand: ({ editor, range }) => {
\t\t\t\teditor.chain().focus().deleteRange(range).run();
\t\t\t\tconst insertPos = pendingBlockInsertPosRef.current ?? range.from;
\t\t\t\tconst relatedAlbumId = block.type === "yohaku.photo" ? findRelatedAlbumId(editor, insertPos) : "";
\t\t\t\tsetPluginBlockDefaultValues(relatedAlbumId ? { albumId: relatedAlbumId } : void 0);
\t\t\t\tsetPluginBlockModal(block);
\t\t\t}
\t\t});`,
  );
  patched = replaceExactly(
    patched,
    "editingBlockPosRef.current = attrs.pos;\n\t\t\tsetPluginBlockInitialValues({",
    "editingBlockPosRef.current = attrs.pos;\n\t\t\tsetPluginBlockDefaultValues(void 0);\n\t\t\tsetPluginBlockInitialValues({",
  );
  patched = replaceExactly(
    patched,
    "setPluginBlockInitialValues(void 0);\n\t\teditingBlockPosRef.current = null;",
    "setPluginBlockInitialValues(void 0);\n\t\tsetPluginBlockDefaultValues(void 0);\n\t\teditingBlockPosRef.current = null;",
  );
  patched = replaceExactly(
    patched,
    `\t\t\t\t\t\tblock: pluginBlockModal,
\t\t\t\t\t\tinitialValues: pluginBlockInitialValues,`,
    `\t\t\t\t\t\tblock: pluginBlockModal,
\t\t\t\t\t\tinitialValues: pluginBlockInitialValues,
\t\t\t\t\t\tdefaultValues: pluginBlockDefaultValues,`,
  );
  patched = replaceExactly(
    patched,
    "setPluginBlockInitialValues(void 0);\n\t\t\t\t\t\t\teditingBlockPosRef.current = null;",
    "setPluginBlockInitialValues(void 0);\n\t\t\t\t\t\t\tsetPluginBlockDefaultValues(void 0);\n\t\t\t\t\t\t\teditingBlockPosRef.current = null;",
  );
  return upgradeForDistributedAdminCss(upgradeRelatedMediaVisualPicker(patched));
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
  const patched = patchEmDashRelatedMediaSource(source);
  if (patched === source) {
    console.log(
      `@emdash-cms/admin ${version}: related-media picker patch already applied`,
    );
    return;
  }
  await writeFile(bundlePath, patched);
  console.log(
    `@emdash-cms/admin ${version}: patched related-media picker integration`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (invokedPath === import.meta.url) await patchInstalledAdmin();
