import {
	EMBED_FULL_URL_GUIDANCE as embedFullUrlGuidance,
	parseEmbedUrl as parseEmbedUrlImpl,
} from "./embed-url.mjs";

export type EmbedProvider = "tiktok" | "spotify";
export type SpotifyEmbedKind = "track" | "album" | "playlist" | "artist" | "show" | "episode";
export type EmbedDisplay = "player" | "link-card";

export type ParsedEmbedUrl =
	| {
			ok: true;
			provider: "tiktok";
			providerLabel: "TikTok";
			kind: "video";
			id: string;
			canonicalUrl: string;
			embedUrl: string;
			title: string;
			height: number;
	  }
	| {
			ok: true;
			provider: "spotify";
			providerLabel: "Spotify";
			kind: SpotifyEmbedKind;
			id: string;
			canonicalUrl: string;
			embedUrl: string;
			title: string;
			height: number;
	  }
	| {
			ok: false;
			reason: "empty" | "invalid" | "short-url" | "unsupported";
			message: string;
			provider?: EmbedProvider;
			providerLabel?: "TikTok" | "Spotify";
			safeUrl?: string;
	  };

export const EMBED_FULL_URL_GUIDANCE: string = embedFullUrlGuidance;

/** Typed application wrapper around the browser-shareable parser. */
export function parseEmbedUrl(input: unknown): ParsedEmbedUrl {
	return parseEmbedUrlImpl(input) as ParsedEmbedUrl;
}
