import type { PortableTextBlockConfig } from "emdash";

/**
 * TikTok and Spotify share one block so switching presentation never discards
 * the source URL or article-owned caption.
 */
export const embedBlocks: PortableTextBlockConfig[] = [
	{
		type: "yohaku.embed",
		label: "TikTok / Spotify（キャプション付き）",
		icon: "video",
		category: "メディア",
		description: "公式URLをリンクカードまたはクリックして読み込むプレーヤーで表示します",
		fields: [
			{
				type: "text_input",
				action_id: "id",
				label: "TikTok / Spotify URL",
				placeholder: "https://www.tiktok.com/@.../video/... または https://open.spotify.com/...",
			},
			{
				type: "select",
				action_id: "display",
				label: "表示方法",
				initial_value: "player",
				options: [
					{ label: "プレーヤー", value: "player" },
					{ label: "リンクカード", value: "link-card" },
				],
			},
			{
				type: "text_input",
				action_id: "caption",
				label: "記事内キャプション",
				multiline: true,
			},
		],
	},
];
