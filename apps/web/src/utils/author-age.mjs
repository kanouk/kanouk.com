const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function zonedDateParts(date, timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return {
		year: Number(values.year),
		month: Number(values.month),
		day: Number(values.day),
	};
}

/**
 * Calculate a public author age on the calendar date in the requested zone.
 * The default keeps the birthday boundary aligned with the author's local day,
 * even though Cloudflare executes in UTC.
 */
export function calculateAge(birthDate, now = new Date(), timeZone = "Asia/Tokyo") {
	const match = DATE_PATTERN.exec(birthDate);
	if (!match) throw new TypeError("birthDate must use YYYY-MM-DD");

	const birthYear = Number(match[1]);
	const birthMonth = Number(match[2]);
	const birthDay = Number(match[3]);
	const current = zonedDateParts(now, timeZone);
	const beforeBirthday =
		current.month < birthMonth ||
		(current.month === birthMonth && current.day < birthDay);

	return current.year - birthYear - (beforeBirthday ? 1 : 0);
}
