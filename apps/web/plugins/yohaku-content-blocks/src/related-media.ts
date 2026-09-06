import type {
	ContentAccess,
	ContentItem,
	PluginDefinition,
	PortableTextBlockConfig,
	PortableTextBlockField,
} from "emdash";

type PickerInput = { values?: Record<string, unknown> };
type PickerItem = { id: string; name: string; values?: Record<string, unknown> };

const textValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const imageValue = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? value as Record<string, unknown> : {};

const entryLabel = (item: ContentItem, fallback: string): string => {
	const title = textValue(item.data.title) || textValue(item.data.caption) || item.slug || fallback;
	return item.status === "published" ? title : `${title}（${item.status}）`;
};

async function listAllContent(
	list: ContentAccess["list"],
	collection: string,
	options: NonNullable<Parameters<ContentAccess["list"]>[1]> = {},
): Promise<ContentItem[]> {
	const items: ContentItem[] = [];
	let cursor: string | undefined;
	do {
		const page = await list(collection, { ...options, cursor, limit: 250 });
		items.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	return items;
}

function dynamicSelect(
	actionId: string,
	label: string,
	optionsRoute: string,
	dependsOn: string[] = [],
	clearFields: string[] = [],
): PortableTextBlockField {
	return {
		type: "select",
		action_id: actionId,
		label,
		options: [],
		optionsRoute,
		...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
		...(clearFields.length > 0 ? { clear_fields: clearFields } : {}),
	} as PortableTextBlockField;
}

export const relatedMediaRoutes = {
	"albums/options": {
		permission: "content:edit_any",
		handler: async (ctx) => {
			if (!ctx.content) return { items: [] as PickerItem[] };
			const albums = await listAllContent(ctx.content.list.bind(ctx.content), "albums");
			return {
				items: albums.map((album): PickerItem => ({
					id: album.id,
					name: entryLabel(album, "無題のアルバム"),
					values: {
						albumSlug: album.slug || "",
						albumTitleSnapshot: textValue(album.data.title),
					},
				})),
			};
		},
	},
	"photos/options": {
		permission: "content:edit_any",
		handler: async (ctx) => {
			if (!ctx.content) return { items: [] as PickerItem[] };
			const input = (ctx.input ?? {}) as PickerInput;
			const albumId = textValue(input.values?.albumId);
			if (!albumId) return { items: [] as PickerItem[] };

			const [album, photos] = await Promise.all([
				ctx.content.get("albums", albumId),
				listAllContent(ctx.content.list.bind(ctx.content), "photos", {
					where: { fieldFilters: { album: albumId } },
					orderBy: { position: "asc" },
				}),
			]);
			if (!album) return { items: [] as PickerItem[] };

			return {
				items: photos.map((photo): PickerItem => {
					const image = imageValue(photo.data.image);
					return {
						id: photo.id,
						name: entryLabel(photo, "無題の写真"),
						values: {
							albumId,
							albumSlug: album.slug || "",
							photoSlug: photo.slug || "",
							imageUrl: textValue(image.src) || textValue(image.url),
							alt: textValue(photo.data.alt) || textValue(image.alt),
							caption: textValue(photo.data.caption),
						},
					};
				}),
			};
		},
	},
} satisfies NonNullable<PluginDefinition["routes"]>;

export const relatedMediaBlocks: PortableTextBlockConfig[] = [
	{
		type: "yohaku.album",
		label: "関連アルバム",
		icon: "link",
		category: "メディア",
		description: "公開アルバムへの関連カードを記事内に挿入します",
		fields: [dynamicSelect("id", "アルバム", "albums/options")],
	},
	{
		type: "yohaku.photo",
		label: "アルバムの写真",
		icon: "image",
		category: "メディア",
		description: "関連アルバムから写真を選び、記事専用の表示とキャプションを設定します",
		fields: [
			dynamicSelect("albumId", "アルバム", "albums/options"),
			dynamicSelect("id", "写真", "photos/options", ["albumId"], [
				"photoSlug",
				"imageUrl",
				"alt",
				"caption",
			]),
			{
				type: "text_input",
				action_id: "caption",
				label: "記事内キャプション（写真のキャプションを初期値として複製）",
				multiline: true,
			},
			{ type: "text_input", action_id: "alt", label: "代替テキスト" },
			{
				type: "number_input",
				action_id: "displayWidth",
				label: "表示幅（px）",
				initial_value: 480,
				min: 240,
				max: 1600,
			},
			{
				type: "select",
				action_id: "frame",
				label: "写真の見せ方",
				initial_value: "photo-frame",
				options: [
					{ label: "写真フレーム", value: "photo-frame" },
					{ label: "境界線", value: "border" },
					{ label: "影", value: "shadow" },
					{ label: "なし", value: "none" },
				],
			},
		],
	},
	{
		type: "yohaku.youtube",
		label: "YouTube（キャプション付き）",
		icon: "video",
		category: "メディア",
		description: "YouTube動画と記事内キャプションを一緒に編集します",
		fields: [
			{ type: "text_input", action_id: "id", label: "YouTube URL または動画ID" },
			{ type: "text_input", action_id: "caption", label: "キャプション", multiline: true },
		],
	},
];
