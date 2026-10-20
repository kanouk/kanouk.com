const SAME_MONTH_SOURCE_ORDER = new Map([
	["2023-01-kyoto", 0],
	["2023-01-nara-kyoto", 1],
	["2020-11-miyajima-kure", 0],
	["2020-11-kyoto", 1],
]);

function albumDateKey(album) {
	const titleMatch = String(album?.data?.title ?? "").match(/(\d{4})\/(\d{2})/);
	const slugMatch = String(album?.id ?? "").match(/(\d{4})-(\d{2})/);
	const match = titleMatch ?? slugMatch;
	return match ? Number(`${match[1]}${match[2]}`) : null;
}

/**
 * Reproduce the public SmugMug homepage order without relying on migration-time
 * published_at values. Stream and Stations are curated anchors; dated albums
 * descend by the year/month shown in their source title.
 */
export function sortAlbumsLikeSmugMug(albums) {
	return [...albums].sort((left, right) => {
		if (left.id === "stream") return right.id === "stream" ? 0 : -1;
		if (right.id === "stream") return 1;
		if (left.id === "stations") return right.id === "stations" ? 0 : 1;
		if (right.id === "stations") return -1;

		const leftDate = albumDateKey(left);
		const rightDate = albumDateKey(right);
		if (leftDate !== rightDate) {
			if (leftDate === null) return 1;
			if (rightDate === null) return -1;
			return rightDate - leftDate;
		}

		const leftSourceOrder = SAME_MONTH_SOURCE_ORDER.get(left.id);
		const rightSourceOrder = SAME_MONTH_SOURCE_ORDER.get(right.id);
		if (leftSourceOrder !== undefined || rightSourceOrder !== undefined) {
			return (leftSourceOrder ?? Number.MAX_SAFE_INTEGER) - (rightSourceOrder ?? Number.MAX_SAFE_INTEGER);
		}

		return String(left.data?.title ?? left.id).localeCompare(
			String(right.data?.title ?? right.id),
			"en",
		);
	});
}

/**
 * The owner's manual order (saved from the organizer or the app), by album
 * content id. Albums added since it was saved come first, in the default order,
 * as SmugMug shows new galleries at the top.
 */
export function applySavedAlbumOrder(albums, savedIds) {
	if (!Array.isArray(savedIds) || savedIds.length === 0) return sortAlbumsLikeSmugMug(albums);
	const rank = new Map(savedIds.map((id, index) => [id, index]));
	const contentId = (album) => album?.data?.id ?? album?.id;
	const fresh = sortAlbumsLikeSmugMug(albums.filter((album) => !rank.has(contentId(album))));
	const placed = albums.filter((album) => rank.has(contentId(album))).sort((left, right) => rank.get(contentId(left)) - rank.get(contentId(right)));
	return [...fresh, ...placed];
}
