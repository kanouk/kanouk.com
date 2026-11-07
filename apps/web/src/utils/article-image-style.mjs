export const articleImageStyles = [
	{ value: "photo-frame", label: "フォトフレーム" },
	{ value: "none", label: "装飾なし" },
	{ value: "rounded", label: "角丸" },
	{ value: "border", label: "枠あり" },
	{ value: "shadow", label: "影あり" },
];

export function resolveArticleImageStyle(value) {
	return articleImageStyles.some((style) => style.value === value) ? value : "photo-frame";
}
