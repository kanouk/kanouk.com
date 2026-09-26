// Link card auto-preview values. Manual fields always win; the automatic
// snapshot is bound to the exact requested URL (see link-preview route).

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
