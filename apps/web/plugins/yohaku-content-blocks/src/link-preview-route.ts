import { z } from "astro/zod";
import { PluginRouteError, type KVAccess, type PluginDefinition } from "emdash";
import {
	getLinkPreview,
	LinkPreviewError,
	MAX_LINK_PREVIEW_URL_LENGTH,
	type LinkPreviewMetadata,
} from "./link-preview.ts";

interface RateRecord { windowStart: number; count: number }
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

async function enforceRateLimit(kv: KVAccess, identity: string, now = Date.now()): Promise<void> {
	const identityDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
	const key = `rate:link-preview:${[...new Uint8Array(identityDigest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const current = await kv.get<RateRecord>(key);
	const record = current && now - current.windowStart < RATE_WINDOW_MS
		? current
		: { windowStart: now, count: 0 };
	if (record.count >= RATE_MAX) throw new PluginRouteError("RATE_LIMITED", "しばらく待ってから再試行してください。", 429);
	await kv.set(key, { ...record, count: record.count + 1 });
}

type InternalResolver = (url: string) => Promise<LinkPreviewMetadata | null>;

async function runtimeInternalResolver(url: string): Promise<LinkPreviewMetadata | null> {
	const [{ env }, { resolveInternalLinkPreview }] = await Promise.all([
		import("virtual:emdash/env"),
		import("../../../src/utils/article-social.ts"),
	]);
	return resolveInternalLinkPreview(env.DB, url);
}

export function createLinkPreviewRoutes(resolveInternal: InternalResolver = runtimeInternalResolver) {
	return {
		"link-preview": {
			permission: "content:edit_any",
			input: z.object({ url: z.string().min(1).max(MAX_LINK_PREVIEW_URL_LENGTH) }),
			handler: async (ctx) => {
				if (ctx.request.method !== "POST") throw new PluginRouteError("METHOD_NOT_ALLOWED", "POST のみ利用できます。", 405);
				if (!ctx.user?.id) throw PluginRouteError.unauthorized();
				await enforceRateLimit(ctx.kv, ctx.user.id);
				try {
					const result = await getLinkPreview(ctx.input.url, ctx.kv, { resolveInternal });
					if (!result) throw new PluginRouteError("NOT_FOUND", "公開中のリンク先が見つかりません。", 404);
					return result;
				} catch (error) {
					if (!(error instanceof LinkPreviewError)) throw error;
					const status = error.code === "INVALID_URL" || error.code === "SSRF_BLOCKED" ? 400 : error.code === "TIMEOUT" ? 504 : 502;
					throw new PluginRouteError(error.code, error.message, status);
				}
			},
		},
	} satisfies NonNullable<PluginDefinition["routes"]>;
}

export const linkPreviewRoutes = createLinkPreviewRoutes();
