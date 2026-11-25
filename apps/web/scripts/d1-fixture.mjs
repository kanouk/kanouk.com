// Minimal D1-shaped adapter over node:sqlite for tests.
import { readFileSync } from "node:fs";

export const REF_INDEX_UP = readFileSync(new URL("../migrations/kanouk/0001_ref_index.up.sql", import.meta.url), "utf8");
export const REF_INDEX_DOWN = readFileSync(new URL("../migrations/kanouk/0001_ref_index.down.sql", import.meta.url), "utf8");

/**
 * @param {import("node:sqlite").DatabaseSync} sqlite
 * @param {{ onPrepare?: (sql: string) => void }} [hooks]
 */
export function d1(sqlite, hooks = {}) {
	const statement = (sql, values = []) => ({
		sql,
		values,
		bind: (...next) => statement(sql, next),
		first: async () => sqlite.prepare(sql).get(...values) ?? null,
		all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
		run: async () => sqlite.prepare(sql).run(...values),
	});
	return {
		prepare(sql) {
			hooks.onPrepare?.(sql);
			return statement(sql);
		},
		async batch(statements) {
			sqlite.exec("BEGIN");
			try {
				const results = statements.map((entry) => sqlite.prepare(entry.sql).run(...entry.values));
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
}
