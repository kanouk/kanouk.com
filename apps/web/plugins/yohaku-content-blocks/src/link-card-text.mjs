// The WordPress importer used this placeholder when no title was available.
// It is not a manual title and must not suppress current OGP metadata.
export function linkCardText(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "関連記事" ? "" : text;
}
