import type { APIRoute } from "astro";
import {
	isAllowedPhotoHost,
	redeemStudioHandoff,
	STUDIO_SESSION_COOKIE,
	STUDIO_SESSION_TTL_SECONDS,
} from "../../studio/session";
import { studioEnvironment } from "../../studio/environment";

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
	if (!isAllowedPhotoHost(url.hostname)) {
		return new Response("写真サイトで開いてください。", {
			status: 400,
			headers: { "Cache-Control": "private, no-store" },
		});
	}
	const token = url.searchParams.get("token") ?? "";
	const redeemed = await redeemStudioHandoff(
		studioEnvironment(),
		token,
	);
	if (!redeemed) {
		return new Response("この管理リンクは期限切れか、すでに使用されています。", {
			status: 410,
			headers: { "Cache-Control": "private, no-store" },
		});
	}
	cookies.set(STUDIO_SESSION_COOKIE, redeemed.sessionId, {
		httpOnly: true,
		secure: url.protocol === "https:",
		sameSite: "lax",
		path: "/",
		maxAge: STUDIO_SESSION_TTL_SECONDS,
	});
	// EmDash only initializes its complete content/media runtime for public
	// routes while edit mode is active. Keep this host-only and HttpOnly: the
	// public management UI authenticates with STUDIO_SESSION_COOKIE instead of
	// exposing either cookie to browser JavaScript.
	cookies.set("emdash-edit-mode", "true", {
		httpOnly: true,
		secure: url.protocol === "https:",
		sameSite: "lax",
		path: "/",
		maxAge: STUDIO_SESSION_TTL_SECONDS,
	});
	return redirect(redeemed.returnTo, 303);
};
