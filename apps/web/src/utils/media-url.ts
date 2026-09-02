import type { MediaValue } from "emdash";

interface PortableImageBlock {
	_type?: unknown;
	asset?: {
		_ref?: unknown;
		url?: unknown;
	};
}

/** Resolve an EmDash media reference to the same public URL used by YohakuImage. */
export function resolvePublicMediaUrl(
	media: MediaValue | string | null | undefined,
): string | undefined {
	if (typeof media === "string") return media || undefined;
	if (!media) return undefined;
	const storageKey = media.meta?.storageKey;
	const legacyUrl = (media as MediaValue & { url?: string }).url;
	return media.src
		|| legacyUrl
		|| (typeof storageKey === "string"
			? `/_emdash/api/media/file/${encodeURIComponent(storageKey)}`
			: media.id
				? `/_emdash/api/media/file/${encodeURIComponent(media.id)}`
				: undefined);
}

/** Resolve the first image embedded in Portable Text for social-card fallbacks. */
export function resolveFirstPortableImageUrl(
	content: unknown[] | null | undefined,
): string | undefined {
	if (!content) return undefined;
	const image = content.find((block): block is PortableImageBlock => {
		if (!block || typeof block !== "object") return false;
		return (block as PortableImageBlock)._type === "image";
	});
	if (!image?.asset) return undefined;

	const assetUrl = typeof image.asset.url === "string" ? image.asset.url : undefined;
	if (assetUrl) {
		return /^[A-Za-z0-9._-]+$/.test(assetUrl)
			? `/_emdash/api/media/file/${encodeURIComponent(assetUrl)}`
			: assetUrl;
	}

	const reference = typeof image.asset._ref === "string" ? image.asset._ref : undefined;
	return reference
		? `/_emdash/api/media/file/${encodeURIComponent(reference)}`
		: undefined;
}

/** Turn a public media path into the absolute URL required by Open Graph. */
export function absoluteMediaUrl(
	mediaUrl: string | null | undefined,
	origin: string,
): string | undefined {
	return mediaUrl ? new URL(mediaUrl, origin).toString() : undefined;
}
