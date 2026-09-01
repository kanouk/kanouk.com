import type { MediaValue } from "emdash";

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
