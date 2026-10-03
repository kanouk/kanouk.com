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
