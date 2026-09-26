import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { parseEmbedUrl } from "../embed-url.mjs";
import { yohakuPreviewValue } from "./link-preview-auto.mjs";

// Editor preview for yohaku.embed. No provider script or iframe is created
// until the editor explicitly chooses to load the official player.
export function renderEmbedPreview({ values, loadedUrl, onLoad }) {
  const parsed = parseEmbedUrl(values?.id);
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
          type: "button", onClick: () => onLoad(parsed.embedUrl),
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

export function YohakuEmbedPreview({ values }) {
  const [loadedUrl, setLoadedUrl] = useState("");
  return renderEmbedPreview({ values, loadedUrl, onLoad: setLoadedUrl });
}
