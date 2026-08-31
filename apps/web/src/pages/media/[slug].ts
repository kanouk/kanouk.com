import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
	const slug = params.slug;
	if (!slug) return new Response("Not found", { status: 404 });

	const { entry: photo } = await getEmDashEntry("photos", slug);
	const image = photo?.data.image as
		| { meta?: { storageKey?: unknown } }
		| null
		| undefined;
	const storageKey = image?.meta?.storageKey;
	if (typeof storageKey !== "string" || !storageKey) {
		return new Response("Not found", { status: 404 });
	}

	const target = new URL(
		`/_emdash/api/media/file/${encodeURIComponent(storageKey)}`,
		url.origin,
	);
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			"Cache-Control": "public, max-age=300",
			"X-Robots-Tag": "noindex",
		},
	});
};
