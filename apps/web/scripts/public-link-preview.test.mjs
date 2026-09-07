import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const {
	createD1LinkPreviewCache,
} = await import("../plugins/yohaku-content-blocks/src/link-preview.ts");
const {
	createLinkPreviewCoordinator,
	findPublishedLinkCard,
	parsePublicLinkPreviewRequest,
	resolvePublicLinkPreview,
} = await import("../plugins/yohaku-content-blocks/src/public-link-preview.ts");

function fixtureDatabase() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE ec_posts (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE ec_pages (
			id TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL, deleted_at TEXT,
			live_revision_id TEXT, draft_revision_id TEXT
		);
		CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	const database = {
		prepare(query) {
			const statement = sqlite.prepare(query);
			return {
				bind(...values) {
					return {
						first: async () => statement.get(...values) ?? null,
						run: async () => statement.run(...values),
					};
				},
			};
		},
	};
	return { sqlite, database };
}

function addEntry(sqlite, collection, { id, slug = id, status = "published", content, draftContent }) {
	const live = `${id}-live`;
	sqlite.prepare("INSERT INTO revisions VALUES (?, ?)").run(live, JSON.stringify({ title: id, content }));
	let draft = null;
	if (draftContent) {
		draft = `${id}-draft`;
		sqlite.prepare("INSERT INTO revisions VALUES (?, ?)").run(draft, JSON.stringify({ title: id, content: draftContent }));
	}
	sqlite.prepare(`INSERT INTO ec_${collection} VALUES (?, ?, ?, NULL, ?, ?)`)
		.run(id, slug, status, live, draft);
}

const publicDns = async () => ["93.184.216.34"];
const externalHtml = (title) => new Response(
	`<html><head><meta property="og:title" content="${title}"><meta name="description" content="Description"><meta property="og:image" content="https://images.example.org/card.jpg"></head></html>`,
	{ headers: { "Content-Type": "text/html" } },
);

test("Astro registers the underscore-prefixed public endpoint explicitly", async () => {
	const [config, endpoint] = await Promise.all([
		readFile(new URL("../astro.config.mjs", import.meta.url), "utf8"),
		readFile(new URL("../src/routes/link-preview.ts", import.meta.url), "utf8"),
	]);
	assert.match(config, /pattern: "\/_yohaku\/link-preview"/);
	assert.match(config, /entrypoint: new URL\("\.\/src\/routes\/link-preview\.ts", import\.meta\.url\)/);
	assert.match(endpoint, /Cache-Control": "private, no-store"/);
	assert.match(endpoint, /export const HEAD: APIRoute = ALL/);
});

test("public request parser rejects every URL proxy shape and duplicate identity", () => {
	assert.deepEqual(parsePublicLinkPreviewRequest(new URL(
		"https://blog.kanouk.com/_yohaku/link-preview?collection=posts&entryId=hello&blockKey=card-1",
	)), { collection: "posts", entryId: "hello", blockKey: "card-1" });
	assert.equal(parsePublicLinkPreviewRequest(new URL(
		"https://blog.kanouk.com/_yohaku/link-preview?collection=posts&entryId=hello&blockKey=card-1&url=https://example.org",
	)), null);
	assert.equal(parsePublicLinkPreviewRequest(new URL(
		"https://blog.kanouk.com/_yohaku/link-preview?collection=posts&entryId=hello&entryId=other&blockKey=card-1",
	)), null);
});

test("lookup returns only an exact top-level card in the current published live revision", async () => {
	const { sqlite, database } = fixtureDatabase();
	addEntry(sqlite, "posts", {
		id: "post-1",
		slug: "hello",
		content: [
			{ _type: "yohaku.linkCard", _key: "external", id: "https://example.org/article" },
			{ _type: "yohaku.embed", _key: "embed-card", display: "link-card", id: "https://www.youtube.com/watch?v=abc" },
			{ _type: "yohaku.embed", _key: "embed-player", display: "player", id: "https://www.youtube.com/watch?v=def" },
		],
		draftContent: [{ _type: "yohaku.linkCard", _key: "draft-only", id: "https://private.example.org" }],
	});
	addEntry(sqlite, "pages", {
		id: "draft-page",
		status: "draft",
		content: [{ _type: "yohaku.linkCard", _key: "hidden", id: "https://private.example.org" }],
	});
	assert.equal((await findPublishedLinkCard(database, "posts", "hello", "external"))?.url, "https://example.org/article");
	assert.equal((await findPublishedLinkCard(database, "posts", "post-1", "embed-card"))?.url, "https://www.youtube.com/watch?v=abc");
	assert.equal(await findPublishedLinkCard(database, "posts", "post-1", "embed-player"), null);
	assert.equal(await findPublishedLinkCard(database, "posts", "post-1", "draft-only"), null);
	assert.equal(await findPublishedLinkCard(database, "pages", "draft-page", "hidden"), null);
	sqlite.close();
});

test("cold external lookup fetches once, then shares its 24-hour cache by URL", async () => {
	const { sqlite, database } = fixtureDatabase();
	const cache = createD1LinkPreviewCache(database);
	let fetches = 0;
	let now = Date.parse("2026-09-07T00:00:00Z");
	const options = {
		origin: "https://blog.kanouk.com",
		now: () => now,
		resolveInternal: async () => null,
		resolveDns: publicDns,
		fetch: async () => { fetches += 1; return externalHtml("Fetched title"); },
	};
	const first = await resolvePublicLinkPreview({
		collection: "posts", entryId: "one", blockKey: "a", url: "https://example.org/article",
	}, cache, options);
	assert.equal(first.state, "refreshed");
	assert.equal(first.metadata.title, "Fetched title");
	assert.equal(first.metadata.fetchedAt, "2026-09-07T00:00:00.000Z");
	const second = await resolvePublicLinkPreview({
		collection: "pages", entryId: "two", blockKey: "b", url: "https://example.org/article",
	}, cache, options);
	assert.equal(second.state, "fresh");
	assert.equal(fetches, 1);
	now += 23 * 60 * 60 * 1000;
	assert.equal((await resolvePublicLinkPreview({
		collection: "posts", entryId: "one", blockKey: "a", url: "https://example.org/article",
	}, cache, options)).state, "fresh");
	assert.equal(fetches, 1);
	sqlite.close();
});

test("stale cache remains visible when refresh fails and negative retry suppresses a loop", async () => {
	const { sqlite, database } = fixtureDatabase();
	const cache = createD1LinkPreviewCache(database);
	let now = Date.parse("2026-09-07T00:00:00Z");
	let fetches = 0;
	const card = { collection: "posts", entryId: "one", blockKey: "a", url: "https://example.org/article" };
	const base = {
		origin: "https://blog.kanouk.com",
		now: () => now,
		resolveInternal: async () => null,
		resolveDns: publicDns,
	};
	await resolvePublicLinkPreview(card, cache, { ...base, fetch: async () => externalHtml("Last good") });
	now += 25 * 60 * 60 * 1000;
	const failed = await resolvePublicLinkPreview(card, cache, {
		...base,
		fetch: async () => { fetches += 1; throw new Error("offline"); },
	});
	assert.equal(failed.state, "stale");
	assert.equal(failed.metadata.title, "Last good");
	const suppressed = await resolvePublicLinkPreview(card, cache, {
		...base,
		fetch: async () => { fetches += 1; throw new Error("must not run"); },
	});
	assert.equal(suppressed.state, "stale");
	assert.equal(fetches, 1);
	sqlite.close();
});

test("current internal publication is authoritative and never falls back to an old snapshot", async () => {
	const { sqlite, database } = fixtureDatabase();
	const cache = createD1LinkPreviewCache(database);
	const card = { collection: "posts", entryId: "one", blockKey: "a", url: "https://blog.kanouk.com/posts/target" };
	const live = await resolvePublicLinkPreview(card, cache, {
		origin: "https://blog.kanouk.com",
		resolveInternal: async () => ({
			url: card.url, title: "Current title", description: "Current", imageUrl: "",
		}),
	});
	assert.equal(live.state, "fresh");
	assert.equal(live.authoritative, true);
	const unpublished = await resolvePublicLinkPreview(card, cache, {
		origin: "https://blog.kanouk.com",
		resolveInternal: async () => null,
		fetch: async () => { throw new Error("own host must never fetch"); },
	});
	assert.deepEqual(unpublished, { state: "negative", authoritative: true });
	assert.deepEqual(await resolvePublicLinkPreview(card, cache, {
		origin: "https://blog.kanouk.com",
		resolveInternal: async () => { throw new Error("database unavailable"); },
	}), { state: "negative", authoritative: true });
	sqlite.close();
});

test("bounded coordinator declines excess work without starting it", async () => {
	const coordinator = createLinkPreviewCoordinator(1);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const first = coordinator.tryRun(async () => { await gate; return "done"; });
	const second = await coordinator.tryRun(async () => "should-not-run");
	assert.deepEqual(second, { acquired: false });
	release();
	assert.deepEqual(await first, { acquired: true, value: "done" });
});
