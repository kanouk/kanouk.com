import type { APIRoute } from "astro";
import {
	issueStudioHandoff,
	photoOriginFor,
} from "../../../studio/session";
import { studioEnvironment } from "../../../studio/environment";

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});
}

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user || locals.user.role < 50) {
		return json({ success: false, error: "管理者としてログインしてください。" }, 403);
	}
	const origin = request.headers.get("Origin");
	if (!origin || origin !== new URL(request.url).origin) {
		return json({ success: false, error: "不正な送信元です。" }, 403);
	}

	let returnTo: unknown = "/albums";
	try {
		returnTo = (await request.json() as { returnTo?: unknown }).returnTo;
	} catch {
		// The default destination is safe and sufficient.
	}

	try {
		const env = studioEnvironment();
		const token = await issueStudioHandoff(env, locals.user, returnTo);
		const target = new URL("/studio/handoff", photoOriginFor(new URL(request.url)));
		target.searchParams.set("token", token);
		target.searchParams.set("returnTo", typeof returnTo === "string" ? returnTo : "/albums");
		return json({ success: true, url: target.toString(), expiresIn: 90 });
	} catch (error) {
		console.error("[studio] handoff issuance failed", error);
		return json({ success: false, error: "管理モードを開始できませんでした。" }, 500);
	}
};
