import type { APIRoute } from "astro";
import {
	isSameOriginMutation,
	readStudioSession,
	revokeStudioSession,
	STUDIO_SESSION_COOKIE,
} from "../../../studio/session";
import { studioEnvironment } from "../../../studio/environment";

export const prerender = false;

function response(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});
}

export const GET: APIRoute = async ({ cookies }) => {
	const session = await readStudioSession(
		studioEnvironment(),
		cookies.get(STUDIO_SESSION_COOKIE)?.value,
	);
	return response({ active: Boolean(session), expiresAt: session?.expiresAt ?? null });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
	if (!isSameOriginMutation(request)) return response({ success: false }, 403);
	const sessionId = cookies.get(STUDIO_SESSION_COOKIE)?.value;
	await revokeStudioSession(studioEnvironment(), sessionId);
	cookies.delete(STUDIO_SESSION_COOKIE, { path: "/" });
	cookies.delete("emdash-edit-mode", { path: "/" });
	return response({ success: true });
};
