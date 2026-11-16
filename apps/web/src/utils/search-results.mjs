const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };

/** Plain text of an EmDash search snippet: markup removed, entities decoded, whitespace normalised. */
export function snippetText(snippet) {
	if (typeof snippet !== "string") return "";
	return snippet
		.replace(/<[^>]*>/g, "")
		.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity])
		.replace(/\s+/g, " ")
		.trim();
}

const normalise = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** True when the snippet only repeats the title, so showing it adds nothing. */
export function snippetRepeatsTitle(snippet, title) {
	const text = snippetText(snippet);
	return text === "" || text === normalise(title);
}

export function normalizeSearchSort(value) {
	return value === "new" ? "new" : "relevance";
}

const timeOf = (value) => {
	const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(time) ? time : undefined;
};

/** Newest first (items without a date last); relevance keeps the search ranking. Never mutates the input. */
export function sortSearchResults(items, sort) {
	const list = [...items];
	if (normalizeSearchSort(sort) !== "new") return list;
	return list
		.map((item, index) => ({ item, index, time: timeOf(item.date) }))
		.sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity) || a.index - b.index)
		.map(({ item }) => item);
}

/** Search is capped, so a full page of hits may be only part of the matches. */
export function searchCountLabel(count, limit) {
	return count >= limit ? `${limit.toLocaleString("ja-JP")}件以上` : `${count.toLocaleString("ja-JP")}件`;
}
