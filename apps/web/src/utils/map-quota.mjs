/** Google bills 10,000 free map loads a month; stop short of it so the maps stay free. */
export const MONTHLY_GOOGLE_MAP_LOADS = 9500;

const RESERVE_LOAD = `
	INSERT INTO map_load_counts (month, loads) VALUES (?1, 1)
	ON CONFLICT (month) DO UPDATE SET loads = loads + 1 WHERE loads < ?2
	RETURNING loads
`;
const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS map_load_counts (month TEXT PRIMARY KEY, loads INTEGER NOT NULL)";

/** Google's free usage resets on the 1st at midnight Pacific time. */
export function billingMonth(now = new Date()) {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
}

/** Count one Google map load. Returns false once this month's loads are used up. */
export async function reserveGoogleMapLoad(database, now = new Date(), limit = MONTHLY_GOOGLE_MAP_LOADS) {
	const reserve = () => database.prepare(RESERVE_LOAD).bind(billingMonth(now), limit).first();
	try {
		return (await reserve()) !== null;
	} catch (error) {
		if (!String(error).includes("no such table")) throw error;
		await database.prepare(CREATE_TABLE).run();
		return (await reserve()) !== null;
	}
}
