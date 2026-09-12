/** Resolve persisted CMS image values without treating external provider IDs as R2 keys. */
export function resolveImageSource(value: unknown): string | undefined {
	const media = typeof value === "string" ? { src: value } : value;
	if (!media || typeof media !== "object") return undefined;
	const image = media as Record<string, unknown>;
	for (const candidate of [image.src, image.url, image.provider === "external-url" ? image.previewUrl : undefined]) {
		if (typeof candidate !== "string") continue;
		const source = candidate.trim();
		if (!source || /[\u0000-\u0020\\]/.test(source)) continue;
		if (source.startsWith("/") && !source.startsWith("//")) return source;
		try {
			const url = new URL(source);
			if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
		} catch { /* Try the next supported field. */ }
	}
	if (image.provider === "external-url") return undefined;
	const meta = image.meta as Record<string, unknown> | undefined;
	const key = typeof meta?.storageKey === "string" && meta.storageKey.trim() ? meta.storageKey : image.id;
	return typeof key === "string" && key.trim()
		? `/_emdash/api/media/file/${encodeURIComponent(key)}`
		: undefined;
}
