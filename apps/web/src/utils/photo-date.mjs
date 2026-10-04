const SITE_TIME_ZONE = "Asia/Tokyo";
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const tokyoDate = new Intl.DateTimeFormat("en-CA", {
	timeZone: SITE_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/**
 * Calendar date a photo was captured on, as seen in Japan.
 * EmDash 1.0 stores datetimes as UTC, so the stored text can fall on the previous day.
 * Values without a zone are already wall-clock time and are read as written.
 */
export function capturedDateParts(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	const prefix = text.match(DATE_PREFIX);
	if (!prefix) return undefined;
	if (!ZONED.test(text)) return { year: +prefix[1], month: +prefix[2], day: +prefix[3] };
	const time = Date.parse(text);
	if (!Number.isFinite(time)) return undefined;
	const [year, month, day] = tokyoDate.format(time).split("-").map(Number);
	return { year, month, day };
}

/** "2026年6月7日〜11日" style label for an album's capture range, in Japan time. */
export function capturedRangeLabel(from, to) {
	const start = capturedDateParts(from);
	if (!start) return undefined;
	const head = `${start.year}年${start.month}月${start.day}日`;
	const end = capturedDateParts(to);
	if (!end || (end.year === start.year && end.month === start.month && end.day === start.day)) return head;
	if (end.year !== start.year) return `${head}〜${end.year}年${end.month}月${end.day}日`;
	if (end.month !== start.month) return `${head}〜${end.month}月${end.day}日`;
	return `${head}〜${end.day}日`;
}
