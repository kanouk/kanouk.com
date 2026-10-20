/**
 * How an album orders its photos, as chosen per album (SmugMug's "Sort By" +
 * direction). Stored on the album as `sort_method` / `sort_direction`; albums
 * migrated from SmugMug carry "date taken" or "position" (manual), lower case.
 */
export const PHOTO_SORT_METHODS = ["date taken", "position", "filename", "caption", "date uploaded", "date modified"];

const ALIASES = new Map([
	["datetaken", "date taken"], ["date_taken", "date taken"], ["captured", "date taken"],
	["manual", "position"], ["manually", "position"],
	["file name", "filename"], ["file_name", "filename"],
	["dateuploaded", "date uploaded"], ["date_uploaded", "date uploaded"], ["uploaded", "date uploaded"],
	["datemodified", "date modified"], ["date_modified", "date modified"], ["modified", "date modified"],
]);

/** A known method and direction; anything else falls back to capture time, oldest first. */
export function normalizePhotoSort(method, direction) {
	const raw = String(method ?? "").trim().toLowerCase();
	const name = ALIASES.get(raw) ?? raw;
	return {
		method: PHOTO_SORT_METHODS.includes(name) ? name : "date taken",
		direction: String(direction ?? "").trim().toLowerCase() === "desc" ? "desc" : "asc",
	};
}

/** SQL that normalizes a stored method / direction column the same way (for queries that read the album). */
export function sqlSortMethod(expr) {
	const cases = [...ALIASES].map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(" ");
	const known = PHOTO_SORT_METHODS.map((name) => `WHEN '${name}' THEN '${name}'`).join(" ");
	return `(CASE lower(trim(coalesce(${expr},''))) ${known} ${cases} ELSE 'date taken' END)`;
}
export function sqlSortDirection(expr) {
	return `(CASE WHEN lower(trim(coalesce(${expr},'')))='desc' THEN 'desc' ELSE 'asc' END)`;
}

/** A normalized method or direction as a SQL string literal (values come from the whitelist above). */
export const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * ORDER BY terms that follow the album's sort. `m` and `d` are SQL expressions
 * (a literal or the normalized album columns); `c` names the photo columns.
 * Terms that do not apply evaluate to NULL for every row and change nothing;
 * position and id always break ties so the order is stable.
 * Column expressions are fixed by the callers, never user input.
 */
export function photoOrderSql(m, d, c) {
	const by = (method, value) => [
		`CASE WHEN ${m}='${method}' AND ${d}='asc' THEN ${value} END ASC`,
		`CASE WHEN ${m}='${method}' AND ${d}='desc' THEN ${value} END DESC`,
	];
	return [
		`CASE WHEN ${m}='date taken' THEN ${c.captured} IS NULL END ASC`,
		...by("date taken", c.captured),
		...by("position", c.position),
		...by("filename", `lower(${c.filename})`),
		...by("caption", `lower(${c.caption})`),
		...by("date uploaded", c.created),
		...by("date modified", c.updated),
		`${c.position} ASC`,
		`${c.id} ASC`,
	].join(", ");
}

/**
 * The same order in JavaScript, for lists already loaded in the organizer.
 * `photo` is a content item ({ id, data, createdAt, updatedAt }).
 */
export function photoComparator(method, direction) {
	const sort = normalizePhotoSort(method, direction);
	const sign = sort.direction === "desc" ? -1 : 1;
	const text = (value) => (typeof value === "string" ? value.toLowerCase() : "");
	const time = (value) => {
		const parsed = typeof value === "string" ? Date.parse(value) : NaN;
		return Number.isFinite(parsed) ? parsed : null;
	};
	const position = (photo) => Number(photo?.data?.position) || 0;
	const key = (photo) => {
		switch (sort.method) {
			case "position": return position(photo);
			case "filename": return text(photo?.data?.image?.filename);
			case "caption": return text(photo?.data?.caption);
			case "date uploaded": return time(photo?.createdAt);
			case "date modified": return time(photo?.updatedAt);
			default: return time(photo?.data?.captured_at);
		}
	};
	return (left, right) => {
		const a = key(left);
		const b = key(right);
		if (a !== b) {
			// Undated photos go last whichever way capture time runs (as in the SQL).
			if (a === null) return 1;
			if (b === null) return -1;
			return (a < b ? -1 : 1) * sign;
		}
		return position(left) - position(right) || String(left?.id).localeCompare(String(right?.id));
	};
}
