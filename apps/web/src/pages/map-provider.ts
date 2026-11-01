import type { APIRoute } from "astro";
import { env } from "virtual:emdash/env";

import { reserveGoogleMapLoad } from "../utils/map-quota.mjs";

export const prerender = false;

/** Which map to draw next. A "google" answer has already counted the load. */
export const POST: APIRoute = async () => {
	if (!env?.DB) throw new Error("Cloudflare D1 binding DB is unavailable");
	const google = await reserveGoogleMapLoad(env.DB);
	return Response.json({ provider: google ? "google" : "osm" }, { headers: { "Cache-Control": "private, no-store" } });
};
