import type { APIRoute } from "astro";
import { env } from "virtual:emdash/env";
import { createD1LinkPreviewCache } from "../../plugins/yohaku-content-blocks/src/link-preview.ts";
import type { D1LinkPreviewDatabase } from "../../plugins/yohaku-content-blocks/src/link-preview.ts";
import {
	findPublishedLinkCard,
	parsePublicLinkPreviewRequest,
	resolvePublicLinkPreview,
} from "../../plugins/yohaku-content-blocks/src/public-link-preview.ts";
import { resolveInternalLinkPreview, type ArticleSocialDatabase } from "../utils/article-social.ts";

export const prerender = false;

const PRIVATE_HEADERS = {
	"Cache-Control": "private, no-store",
	"Content-Type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

export const GET: APIRoute = async ({ url }) => {
	const input = parsePublicLinkPreviewRequest(url);
	if (!input) return json({ error: "invalid_query" }, 400);

	const database = env?.DB as (D1LinkPreviewDatabase & ArticleSocialDatabase) | undefined;
	if (!database) return json({ state: "negative", authoritative: false, retryAfterMs: 300_000 }, 503);
	try {
		const card = await findPublishedLinkCard(
			database,
			input.collection,
			input.entryId,
			input.blockKey,
		);
		if (!card) return json({ error: "not_found" }, 404);
		const canonicalOrigin = url.protocol === "https:" ? url.origin : "https://blog.kanouk.com";
		const result = await resolvePublicLinkPreview(card, createD1LinkPreviewCache(database), {
			origin: canonicalOrigin,
			resolveInternal: (target) => resolveInternalLinkPreview(database, target, { origin: url.origin }),
		});
		return json(result);
	} catch {
		return json({ state: "negative", authoritative: false, retryAfterMs: 300_000 });
	}
};

export const ALL: APIRoute = async () => json({ error: "method_not_allowed" }, 405);
export const HEAD: APIRoute = ALL;
