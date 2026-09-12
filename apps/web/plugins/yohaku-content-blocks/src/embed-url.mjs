export const EMBED_FULL_URL_GUIDANCE = "短縮URLには対応していません。共有先をブラウザで開き、TikTok または Spotify の完全なURLを貼り付けてください。";

/**
 * Parse only official, canonical TikTok and Spotify URLs. No redirect is
 * followed. Deliberately self-contained for the native editor bundle patch.
 * @param {unknown} input
 * @returns {any}
 */
export function parseEmbedUrl(input) {
	const fullUrlGuidance = "短縮URLには対応していません。共有先をブラウザで開き、TikTok または Spotify の完全なURLを貼り付けてください。";
	const spotifyKinds = new Set(["track", "album", "playlist", "artist", "show", "episode"]);
	const spotifyKindLabels = {
		track: "曲", album: "アルバム", playlist: "プレイリスト", artist: "アーティスト",
		show: "ポッドキャスト番組", episode: "ポッドキャストエピソード",
	};
	const failure = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });
	const safeOfficialUrl = (url, provider) => {
		if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
		const host = url.hostname.toLowerCase();
		if (provider === "tiktok" && ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) return url.toString();
		if (provider === "spotify" && ["open.spotify.com", "spotify.link"].includes(host)) return url.toString();
		return undefined;
	};

	const raw = typeof input === "string" ? input.trim() : "";
	if (!raw) return failure("empty", "TikTok または Spotify の完全なURLを入力してください。");
	let url;
	try { url = new URL(raw); }
	catch { return failure("invalid", "URLの形式を確認してください。https:// から始まる完全なURLが必要です。"); }
	if (url.protocol !== "https:" || url.username || url.password || url.port) {
		return failure("invalid", "HTTPSの公式URLだけを使用できます。");
	}

	const host = url.hostname.toLowerCase();
	if (["vm.tiktok.com", "vt.tiktok.com"].includes(host)) {
		return failure("short-url", fullUrlGuidance, { provider: "tiktok", providerLabel: "TikTok", safeUrl: safeOfficialUrl(url, "tiktok") });
	}
	if (host === "spotify.link") {
		return failure("short-url", fullUrlGuidance, { provider: "spotify", providerLabel: "Spotify", safeUrl: safeOfficialUrl(url, "spotify") });
	}
	if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host)) {
		if (/^\/t\/[^/]+\/?$/.test(url.pathname)) {
			return failure("short-url", fullUrlGuidance, { provider: "tiktok", providerLabel: "TikTok", safeUrl: safeOfficialUrl(url, "tiktok") });
		}
		const video = url.pathname.match(/^\/@([A-Za-z0-9._-]{2,32})\/video\/(\d{10,30})\/?$/);
		const player = url.pathname.match(/^\/player\/v1\/(\d{10,30})\/?$/);
		const id = video?.[2] ?? player?.[1] ?? "";
		if (!id) {
			return failure("unsupported", "TikTokの動画ページURLを入力してください。プロフィールや検索ページは埋め込めません。", { provider: "tiktok", providerLabel: "TikTok", safeUrl: safeOfficialUrl(url, "tiktok") });
		}
		const canonicalUrl = video ? `https://www.tiktok.com/@${video[1]}/video/${id}` : `https://www.tiktok.com/player/v1/${id}`;
		return {
			ok: true, provider: "tiktok", providerLabel: "TikTok", kind: "video", id, canonicalUrl,
			embedUrl: `https://www.tiktok.com/player/v1/${id}?controls=1&progress_bar=1&closed_caption=1&description=1`,
			title: "TikTok動画プレーヤー", height: 720,
		};
	}
	if (host === "open.spotify.com") {
		const segments = url.pathname.split("/").filter(Boolean);
		if (segments[0]?.startsWith("intl-")) segments.shift();
		if (segments[0] === "embed") segments.shift();
		const kind = segments[0];
		const id = segments[1] ?? "";
		if (segments.length !== 2 || !kind || !spotifyKinds.has(kind) || !/^[A-Za-z0-9]{22}$/.test(id)) {
			return failure("unsupported", "Spotifyの曲、アルバム、プレイリスト、アーティスト、ポッドキャスト番組またはエピソードのURLを入力してください。", { provider: "spotify", providerLabel: "Spotify", safeUrl: safeOfficialUrl(url, "spotify") });
		}
		return {
			ok: true, provider: "spotify", providerLabel: "Spotify", kind, id,
			canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
			embedUrl: `https://open.spotify.com/embed/${kind}/${id}`,
			title: `Spotify ${spotifyKindLabels[kind]}プレーヤー`,
			height: kind === "track" ? 80 : kind === "episode" ? 152 : 352,
		};
	}
	return failure("unsupported", "対応しているのはTikTokとSpotifyの公式URLだけです。");
}

/** Browser-safe declaration source for the native EmDash editor patch. */
export function embedParserBrowserSource() {
	return `const parseEmbedUrl = ${parseEmbedUrl.toString()};`;
}
