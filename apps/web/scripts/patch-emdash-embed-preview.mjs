import { embedParserBrowserSource } from "../plugins/yohaku-content-blocks/src/embed-url.mjs";

export const EMBED_PREVIEW_MARKER = "emdash-kanouk-embed-preview-v9";

// Injected after the pinned bundle's React/JSX imports. No provider script or
// iframe is created until the editor explicitly chooses to load a preview.
export function YohakuEmbedPreview({ values }) {
  const parsed = parseEmbedUrl(values?.id);
  const [loadedUrl, setLoadedUrl] = React$1.useState("");
  if (!parsed.ok) return jsx("p", { role: values?.id ? "alert" : "status", className: "text-sm text-kumo-subtle", children: parsed.message });
  const player = values.display !== "link-card";
  const height = parsed.provider === "tiktok" ? 480 : parsed.height;
  return jsxs("figure", {
    style: { margin: "12px 0", maxWidth: "100%" },
    children: [
      player ? jsx("div", {
        style: { width: parsed.provider === "tiktok" ? 270 : "100%", maxWidth: "100%", height, margin: "0 auto", border: "1px solid var(--color-kumo-line, #ddd)", borderRadius: 8, overflow: "hidden" },
        children: loadedUrl === parsed.embedUrl ? jsx("iframe", {
          src: parsed.embedUrl, title: parsed.title, loading: "lazy", referrerPolicy: "strict-origin-when-cross-origin",
          allow: "encrypted-media; fullscreen; picture-in-picture", allowFullScreen: true,
          style: { display: "block", border: 0, width: "100%", height: "100%" }
        }) : jsxs("button", {
          type: "button", onClick: () => setLoadedUrl(parsed.embedUrl),
          style: { display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center", width: "100%", height: "100%", padding: 16, cursor: "pointer" },
          children: [jsx("strong", { children: `${parsed.providerLabel}をプレビュー` }), jsx("span", { className: "text-xs text-kumo-subtle", children: "クリックすると公式プレーヤーに接続します" })]
        })
      }) : jsxs("div", {
        className: "rounded-md border border-kumo-line p-3 space-y-2",
        children: [yohakuPreviewValue(values, "imageUrl") ? jsx("img", { src: yohakuPreviewValue(values, "imageUrl"), alt: "", referrerPolicy: "no-referrer", style: { maxWidth: "100%", maxHeight: 160, objectFit: "cover" } }) : null,
          jsx("strong", { children: yohakuPreviewValue(values, "title") || `${parsed.providerLabel}のリンクカード` }),
          jsx("p", { className: "text-sm text-kumo-subtle", children: yohakuPreviewValue(values, "description") || "公開ページではリンク先の画像・説明を自動取得します。" })]
      }),
      values.caption ? jsx("figcaption", { className: "mt-2 text-sm text-kumo-subtle", style: { textAlign: "center", whiteSpace: "pre-wrap" }, children: values.caption }) : null,
      jsx("a", { href: parsed.canonicalUrl, target: "_blank", rel: "noopener noreferrer", className: "mt-2 block text-sm underline", children: `${parsed.providerLabel}で開く` })
    ]
  });
}

function replaceExactly(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Embed preview patch expected one match, found ${count}: ${before.slice(0, 100)}. Review the EmDash admin bundle.`);
  return source.replace(before, after);
}

function upgradeEmbedPreviewV9(source) {
  if (source.includes(EMBED_PREVIEW_MARKER)) return source;
  let patched = replaceExactly(source,
    "function PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {",
    `/* ${EMBED_PREVIEW_MARKER} */\n${embedParserBrowserSource()}\n${YohakuEmbedPreview.toString()}\nfunction PluginBlockModal({ block, initialValues, defaultValues, onClose, onInsert }) {`);
  patched = replaceExactly(patched,
    '\t\tif (block?.type !== "yohaku.linkCard" || !block.pluginId) return;',
    '\t\tif (!(block?.type === "yohaku.linkCard" || (block?.type === "yohaku.embed" && formValues.display === "link-card" && parseEmbedUrl(formValues.id).ok)) || !block.pluginId) return;');
  patched = replaceExactly(patched,
    '\t}, [block?.type, block?.pluginId, formValues.id, linkPreviewRefreshNonce]);',
    '\t}, [block?.type, block?.pluginId, formValues.id, formValues.display, linkPreviewRefreshNonce]);');
  patched = replaceExactly(patched,
    '\t\tif (block?.fields && block.fields.length > 0) onInsert(formValues);',
    '\t\tif (block?.type === "yohaku.embed" && !parseEmbedUrl(formValues.id).ok) return;\n\t\tif (block?.fields && block.fields.length > 0) onInsert(formValues);');
  patched = replaceExactly(patched,
    '\tconst canSubmit = hasFields ? hasPluginBlockFormData(formValues) : typeof formValues.id === "string" && formValues.id.trim().length > 0;',
    '\tconst canSubmit = block?.type === "yohaku.embed" ? parseEmbedUrl(formValues.id).ok : hasFields ? hasPluginBlockFormData(formValues) : typeof formValues.id === "string" && formValues.id.trim().length > 0;');
  patched = replaceExactly(patched,
    '\t\t\t\t\tchildren: [hasFields ? block.fields.map((field) =>',
    '\t\t\t\t\tchildren: [block?.type === "yohaku.embed" ? jsx(YohakuEmbedPreview, { values: formValues }) : null, hasFields ? block.fields.map((field) =>');
  patched = replaceExactly(patched,
    '\tconst isYohakuPhoto = blockType === "yohaku.photo";',
    '\tconst isYohakuEmbed = blockType === "yohaku.embed";\n\tconst isYohakuPhoto = blockType === "yohaku.photo";');
  // Insert below the native node toolbar, retaining its edit/copy/delete UI.
  const start = patched.indexOf("function PluginBlockNodeView(");
  const end = patched.indexOf("\nconst PluginBlock", start);
  if (start < 0 || end < 0) throw new Error("Review the EmDash admin bundle: plugin node boundary changed");
  const node = patched.slice(start, end);
  const updated = replaceExactly(node,
    '\t\t\t\t}), isEditing && /* @__PURE__ */ jsx("div", {',
    '\t\t\t\t}), isYohakuEmbed ? jsx("div", { className: "p-3", children: jsx(YohakuEmbedPreview, { values: { ...data, id } }) }) : null, isEditing && /* @__PURE__ */ jsx("div", {');
  patched = patched.slice(0, start) + updated + patched.slice(end);
  return patched;
}

export function upgradeEmbedPreview(source) {
  let patched = upgradeEmbedPreviewV9(source);
  const marker = "emdash-kanouk-embed-preview-status-v10";
  if (patched.includes(marker)) return patched;
  patched = replaceExactly(patched, `/* ${EMBED_PREVIEW_MARKER} */`, `/* ${EMBED_PREVIEW_MARKER} */\n/* ${marker} */`);
  const condition = '(block?.type === "yohaku.linkCard" || (block?.type === "yohaku.embed" && formValues.display === "link-card" && parseEmbedUrl(formValues.id).ok))';
  patched = replaceExactly(patched,
    'block?.type === "yohaku.linkCard" && typeof formValues.id === "string" && formValues.id.trim() ? /* @__PURE__ */ jsx(Button, {',
    `${condition} && typeof formValues.id === "string" && formValues.id.trim() ? /* @__PURE__ */ jsx(Button, {`);
  patched = replaceExactly(patched,
    'block?.type === "yohaku.linkCard" && linkPreviewState.message ? /* @__PURE__ */ jsx("p", {',
    `${condition} && linkPreviewState.message ? /* @__PURE__ */ jsx("p", {`);
  return patched;
}
