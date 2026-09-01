import { env } from "virtual:emdash/env";

export interface PostArchiveMonth {
	year: number;
	month: number;
	count: number;
	label: string;
	href: string;
}

interface ArchiveRow {
	month_key: string;
	post_count: number;
}

interface D1StatementLike {
	bind(...values: unknown[]): D1StatementLike;
	all<T>(): Promise<{ results: T[] }>;
}

interface D1DatabaseLike {
	prepare(query: string): D1StatementLike;
}

function postsDatabase(): D1DatabaseLike {
	const database = env?.DB as D1DatabaseLike | undefined;
	if (!database) throw new Error("Cloudflare D1 binding DB is unavailable");
	return database;
}

export async function getPostArchiveMonths(limit = 36): Promise<PostArchiveMonth[]> {
	const result = await postsDatabase()
		.prepare(`
			SELECT strftime('%Y-%m', published_at, '+9 hours') AS month_key,
			       COUNT(*) AS post_count
			FROM ec_posts
			WHERE status = 'published'
			  AND deleted_at IS NULL
			  AND published_at IS NOT NULL
			GROUP BY month_key
			ORDER BY month_key DESC
			LIMIT ?1
		`)
		.bind(Math.max(1, Math.min(240, Math.trunc(limit))))
		.all<ArchiveRow>();

	return result.results.flatMap((row: ArchiveRow) => {
		const match = row.month_key?.match(/^(\d{4})-(\d{2})$/);
		if (!match) return [];
		const year = Number(match[1]);
		const month = Number(match[2]);
		return [{
			year,
			month,
			count: Number(row.post_count),
			label: `${year}年${month}月`,
			href: `/archives/${year}/${String(month).padStart(2, "0")}`,
		}];
	});
}

export function japanMonthRange(year: number, month: number) {
	const start = new Date(Date.UTC(year, month - 1, 1) - 9 * 60 * 60 * 1000);
	const end = new Date(Date.UTC(year, month, 1) - 9 * 60 * 60 * 1000);
	return { start, end };
}

export function japanDateParts(date: Date) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value);
	return { year: value("year"), month: value("month"), day: value("day") };
}
