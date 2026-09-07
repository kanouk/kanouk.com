// Shared, testable helpers are embedded verbatim in the pinned EmDash admin
// bundle. Keep them self-contained: no module closure or runtime imports.
export const AUTHORING_PREVIEW_MARKER = "emdash-kanouk-authoring-preview-v8";

export function yohakuPreviewUrl(value) {
  try {
    const candidate = typeof value === "string" ? value.trim() : "";
    const url = new URL(candidate, "https://blog.kanouk.com");
    if (!candidate || url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

export function yohakuPreviewValue(values, key) {
  const manual = typeof values?.[key] === "string" ? values[key].trim() : "";
  if (manual) return manual;
  const auto = values?.linkPreviewAuto;
  if (auto?.version !== 1 || auto.url !== yohakuPreviewUrl(values?.id)) return "";
  return typeof auto[key] === "string" ? auto[key] : "";
}

export function yohakuMergePreview(previous, preview, requestedUrl) {
  const url = yohakuPreviewUrl(requestedUrl);
  if (!url || url !== yohakuPreviewUrl(previous?.id)) return previous;
  if (!["title", "description", "imageUrl", "fetchedAt"].every(key => typeof preview?.[key] === "string")) return previous;
  // Bind to the requested card URL, not the final redirect URL. Manual fields
  // are never rewritten, including edits made while the request was running.
  return { ...previous, linkPreviewAuto: { version: 1, url,
    title: preview.title, description: preview.description,
    imageUrl: preview.imageUrl, fetchedAt: preview.fetchedAt } };
}

function replaceExactly(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Authoring preview patch expected one match, found ${count}: ${before.slice(0, 100)}. Review the EmDash admin bundle.`);
  return source.replace(before, after);
}

export function upgradeAuthoringPreview(source) {
  if (source.includes(AUTHORING_PREVIEW_MARKER)) return source;
  let patched = replaceExactly(source,
    "function PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {",
    `/* ${AUTHORING_PREVIEW_MARKER} */\n${yohakuPreviewUrl.toString()}\n${yohakuPreviewValue.toString()}\n${yohakuMergePreview.toString()}\nfunction PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {`);
  patched = replaceExactly(patched,
    `\t\t\t\t\tfor (const key of ["title", "description", "imageUrl"]) {
\t\t\t\t\t\tif (!linkPreviewManualFieldsRef.current.has(key) && typeof preview?.[key] === "string") next[key] = preview[key];
\t\t\t\t\t}
\t\t\t\t\treturn next;`,
    `\t\t\t\t\treturn yohakuMergePreview(next, preview, previewUrl);`);
  // Reopening legacy blocks keeps their nonempty fields manual. URL changes
  // invalidate the auto snapshot through exact URL matching, not data deletion.
  patched = replaceExactly(patched,
    `\t\t\t\tfor (const key of ["title", "description", "imageUrl"]) {
\t\t\t\t\tif (!linkPreviewManualFieldsRef.current.has(key)) next[key] = "";
\t\t\t\t}`,
    `\t\t\t\tfor (const key of ["title", "description", "imageUrl"]) {
\t\t\t\t\tif (linkPreviewManualFieldsRef.current.has(key)) next[key] = previous[key];
\t\t\t\t}`);
  patched = replaceExactly(patched,
    '\t\t\t\t\t\tfield,\n\t\t\t\t\t\tpluginId: block.pluginId,',
    '\t\t\t\t\t\tfield: block.type === "yohaku.linkCard" && ["title", "description", "imageUrl"].includes(field.action_id) ? { ...field, placeholder: yohakuPreviewValue({ ...formValues, [field.action_id]: "" }, field.action_id) || "空欄の場合は自動取得" } : field,\n\t\t\t\t\t\tpluginId: block.pluginId,');
  patched = replaceExactly(patched,
    `block?.type === "yohaku.linkCard" && typeof formValues.imageUrl === "string" && formValues.imageUrl.trim() ? /* @__PURE__ */ jsx("img", {
\t\t\t\t\t\tsrc: formValues.imageUrl.trim(),`,
    `block?.type === "yohaku.linkCard" ? /* @__PURE__ */ jsxs("div", {
        className: "rounded-md border border-kumo-line p-3 space-y-2",
        children: [jsx("p", { className: "text-xs text-kumo-subtle", children: "空欄の項目は自動取得します。手動入力した項目は、再取得しても変わりません。" }),
          jsx("strong", { children: yohakuPreviewValue(formValues, "title") || formValues.id || "リンクのプレビュー" }),
          jsx("p", { className: "text-sm text-kumo-subtle", children: yohakuPreviewValue(formValues, "description") }),
          yohakuPreviewValue(formValues, "imageUrl") ? jsx("img", {
\t\t\t\t\t\tsrc: yohakuPreviewValue(formValues, "imageUrl"),`);
  patched = replaceExactly(patched,
    '\t\t\t\t\t\tclassName: "max-h-48 w-full rounded-md border border-kumo-line object-cover"\n\t\t\t\t\t}) : null]',
    '\t\t\t\t\t\tclassName: "max-h-48 w-full rounded-md border border-kumo-line object-cover"\n\t\t\t\t\t}) : null] }) : null]');
  patched = replaceExactly(patched,
    '\tconst mediaImageUrl = (isYohakuPhoto || isYohakuLinkCard) && typeof data.imageUrl === "string" ? data.imageUrl : "";',
    '\tconst mediaImageUrl = isYohakuLinkCard ? yohakuPreviewValue({ ...data, id }, "imageUrl") : isYohakuPhoto && typeof data.imageUrl === "string" ? data.imageUrl : "";');
  patched = replaceExactly(patched,
    'isYohakuLinkCard && typeof data.title === "string" ? data.title : isYohakuPhoto',
    'isYohakuLinkCard ? yohakuPreviewValue({ ...data, id }, "title") : isYohakuPhoto');
  return patched;
}
