import type { APIRoute } from "astro";
import { POST as emdashMediaPost } from "emdash/routes/api/media";
import { studioEnvironment } from "../../../studio/environment";
import {
	isSameOriginMutation,
	readStudioSession,
	STUDIO_SESSION_COOKIE,
} from "../../../studio/session";

export const prerender = false;

function denied(status: number): Response {
	return new Response(JSON.stringify({ success: false }), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
	});
}

export const POST: APIRoute = async (context) => {
	if (!isSameOriginMutation(context.request)) return denied(403);
	const session = await readStudioSession(
		studioEnvironment(),
		context.cookies.get(STUDIO_SESSION_COOKIE)?.value,
	);
	if (!session) return denied(401);

	// Delegate the request to EmDash's complete upload path so MIME/size
	// validation, content-hash dedupe, enrichment and R2 writes stay in core.
	(context.locals as unknown as { user: { id: string; role: number } }).user = {
		id: session.userId,
		role: session.role,
	};
	return emdashMediaPost(context);
};
