import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

export function yohakuContentBlocks(): PluginDescriptor {
	return {
		id: "yohaku-content-blocks",
		version: "0.1.0",
		entrypoint: "yohaku-content-blocks",
		componentsEntry: "yohaku-content-blocks/astro",
		options: {},
	};
}

export function createPlugin() {
	return definePlugin({
		id: "yohaku-content-blocks",
		version: "0.1.0",
		hooks: {
			"page:metadata": ({ page }) => {
				if (!page.canonical) return null;
				const schemaType = page.pageType === "collection"
					? "CollectionPage"
					: page.pageType === "image"
						? "ImageObject"
						: page.pageType === "video"
							? "VideoObject"
							: null;
				if (!schemaType) return null;
				const graph: Record<string, unknown> = {
					"@context": "https://schema.org",
					"@type": schemaType,
					name: page.pageTitle ?? page.title ?? undefined,
					url: page.canonical,
					description: page.description ?? undefined,
					isPartOf: {
						"@type": "WebSite",
						name: "Photos — kanouk.com",
						url: "https://photos.kanouk.com/albums",
					},
				};
				if (page.image) {
					if (schemaType === "ImageObject") graph.contentUrl = page.image;
					else if (schemaType === "VideoObject") graph.thumbnailUrl = page.image;
					else graph.image = page.image;
				}
				return { kind: "jsonld", id: "primary", graph };
			},
		},
		admin: {
			portableTextBlocks: [
				{
					type: "yohaku.callout",
					label: "補足・要点",
					description: "注意、補足、ポイントを本文から分けて示します",
					fields: [
						{ type: "text_input", action_id: "title", label: "見出し" },
						{ type: "text_input", action_id: "body", label: "本文" },
						{
							type: "select",
							action_id: "tone",
							label: "種類",
							options: [
								{ label: "補足", value: "note" },
								{ label: "ポイント", value: "tip" },
								{ label: "注意", value: "caution" },
							],
						},
					],
				},
				{
					type: "yohaku.dialogue",
					label: "会話・発言",
					description: "人物の発言を、読み上げ可能な引用として示します",
					fields: [
						{ type: "text_input", action_id: "speaker", label: "話者" },
						{ type: "text_input", action_id: "body", label: "発言" },
					],
				},
				{
					type: "yohaku.quote",
					label: "引用",
					description: "出典のある文章を、本文と区別して示します",
					fields: [
						{ type: "text_input", action_id: "body", label: "引用文" },
						{ type: "text_input", action_id: "source", label: "出典" },
					],
				},
				{
					type: "yohaku.linkCard",
					label: "リンクカード",
					icon: "link-external",
					description: "記事内外のリンクをタイトルと説明付きで示します",
					fields: [
						{ type: "text_input", action_id: "id", label: "URL" },
						{ type: "text_input", action_id: "title", label: "タイトル" },
						{ type: "text_input", action_id: "description", label: "説明" },
					],
				},
				{
					type: "yohaku.productCard",
					label: "商品情報",
					icon: "link",
					description: "商品名、画像、購入先を記事より控えめにまとめます",
					fields: [
						{ type: "text_input", action_id: "title", label: "商品名" },
						{ type: "text_input", action_id: "imageUrl", label: "画像URL" },
						{ type: "text_input", action_id: "price", label: "取得時価格（円）" },
						{ type: "text_input", action_id: "id", label: "主なリンク" },
						{ type: "text_input", action_id: "label", label: "リンク表示名" },
					],
				},
				{
					type: "yohaku.steps",
					label: "手順",
					description: "順序のある説明を段階ごとに示します",
					fields: [
						{ type: "text_input", action_id: "title", label: "見出し" },
						{ type: "text_input", action_id: "body", label: "説明" },
					],
				},
				{
					type: "yohaku.accordion",
					label: "折りたたみ",
					description: "補足情報を開閉できる形でまとめます",
					fields: [
						{ type: "text_input", action_id: "title", label: "見出し" },
						{ type: "text_input", action_id: "body", label: "本文" },
					],
				},
				{
					type: "yohaku.rating",
					label: "評価",
					description: "数値評価をテキストでも理解できる形で示します",
					fields: [
						{ type: "number_input", action_id: "score", label: "評価" },
						{ type: "number_input", action_id: "max", label: "満点" },
						{ type: "text_input", action_id: "label", label: "項目名" },
					],
				},
				{
					type: "yohaku.quiz",
					label: "クイズ",
					description: "問題、選択肢、正解と解説を一体で保持します",
					fields: [
						{ type: "text_input", action_id: "title", label: "見出し" },
						{ type: "text_input", action_id: "description", label: "説明" },
					],
				},
				{
					type: "yohaku.siteSearch",
					label: "サイト内検索",
					description: "ブログの検索ページへつながる検索フォームです",
					fields: [
						{ type: "text_input", action_id: "label", label: "ラベル" },
						{ type: "text_input", action_id: "placeholder", label: "入力例" },
					],
				},
			],
		},
	});
}

export default createPlugin;
