/**
 * Page-number windowing for archive lists: 1 … 4 5 6 … 54.
 * Pure functions, no framework imports, so node:test can run them.
 */

export function totalPages(total, pageSize) {
	if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 0;
	return Math.ceil(total / pageSize);
}

/**
 * Items to render between 前のページ and 次のページ. Always includes the first
 * and last page and the current page with `siblings` neighbours on each side.
 * A gap that would hide exactly one page shows that page instead of "…".
 * Returns [{ type: "page", page } | { type: "gap" }].
 */
export function pageWindow(current, last, siblings = 1) {
	if (!Number.isInteger(last) || last < 1) return [];
	const page = Math.min(Math.max(1, Math.trunc(current) || 1), last);
	const wanted = new Set([1, last]);
	for (let n = page - siblings; n <= page + siblings; n++) {
		if (n >= 1 && n <= last) wanted.add(n);
	}
	const sorted = [...wanted].sort((a, b) => a - b);
	const items = [];
	let previous = 0;
	for (const n of sorted) {
		const missing = n - previous - 1;
		if (missing === 1) items.push({ type: "page", page: n - 1 });
		else if (missing > 1) items.push({ type: "gap" });
		items.push({ type: "page", page: n });
		previous = n;
	}
	return items;
}

/** "1,293件中 1〜24件", or "5件" when everything fits on one page. */
export function rangeLabel(total, page, pageSize, shown) {
	const fmt = (n) => n.toLocaleString("ja-JP");
	if (total <= pageSize && page <= 1) return `${fmt(total)}件`;
	if (shown <= 0) return `${fmt(total)}件`;
	const from = (page - 1) * pageSize + 1;
	const to = from + shown - 1;
	return from === to ? `${fmt(total)}件中 ${fmt(from)}件` : `${fmt(total)}件中 ${fmt(from)}〜${fmt(to)}件`;
}
