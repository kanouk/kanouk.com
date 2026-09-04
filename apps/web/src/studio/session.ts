import { sanitizeReturnTo } from "./domain.ts";

export const STUDIO_SESSION_COOKIE = "studio-photo-session";
export const STUDIO_SESSION_TTL_SECONDS = 30 * 60;
export const STUDIO_HANDOFF_TTL_SECONDS = 90;

interface KvNamespace {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface StudioSessionEnvironment {
	SESSION?: KvNamespace;
}

export interface StudioSessionRecord {
	userId: string;
	role: number;
	expiresAt: number;
}

interface HandoffRecord extends StudioSessionRecord {
	returnTo: string;
}

function randomToken(bytes = 32): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	return Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseRecord<T extends StudioSessionRecord>(value: string | null): T | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<T>;
		if (
			typeof parsed.userId !== "string" ||
			typeof parsed.role !== "number" ||
			typeof parsed.expiresAt !== "number"
		) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

export async function issueStudioHandoff(
	env: StudioSessionEnvironment,
	user: { id: string; role: number },
	returnTo: unknown,
): Promise<string> {
	if (!env.SESSION) throw new Error("SESSION binding is not configured");
	const token = randomToken();
	const key = `studio:handoff:${await tokenHash(token)}`;
	const record: HandoffRecord = {
		userId: user.id,
		role: user.role,
		expiresAt: Date.now() + STUDIO_HANDOFF_TTL_SECONDS * 1000,
		returnTo: sanitizeReturnTo(returnTo),
	};
	await env.SESSION.put(key, JSON.stringify(record), {
		expirationTtl: STUDIO_HANDOFF_TTL_SECONDS,
	});
	return token;
}

export async function redeemStudioHandoff(
	env: StudioSessionEnvironment,
	token: string,
): Promise<{ sessionId: string; returnTo: string } | null> {
	if (!env.SESSION || !/^[a-f0-9]{64}$/.test(token)) return null;
	const key = `studio:handoff:${await tokenHash(token)}`;
	const raw = await env.SESSION.get(key);
	await env.SESSION.delete(key);
	const record = parseRecord<HandoffRecord>(raw);
	if (!record || record.expiresAt <= Date.now()) return null;

	const sessionId = randomToken();
	const sessionKey = `studio:session:${await tokenHash(sessionId)}`;
	const session: StudioSessionRecord = {
		userId: record.userId,
		role: record.role,
		expiresAt: Date.now() + STUDIO_SESSION_TTL_SECONDS * 1000,
	};
	await env.SESSION.put(sessionKey, JSON.stringify(session), {
		expirationTtl: STUDIO_SESSION_TTL_SECONDS,
	});
	return { sessionId, returnTo: sanitizeReturnTo(record.returnTo) };
}

export async function readStudioSession(
	env: StudioSessionEnvironment,
	sessionId: string | undefined,
): Promise<StudioSessionRecord | null> {
	if (!env.SESSION || !sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return null;
	const key = `studio:session:${await tokenHash(sessionId)}`;
	const record = parseRecord<StudioSessionRecord>(await env.SESSION.get(key));
	if (!record || record.expiresAt <= Date.now() || record.role < 50) {
		await env.SESSION.delete(key);
		return null;
	}
	return record;
}

export async function revokeStudioSession(
	env: StudioSessionEnvironment,
	sessionId: string | undefined,
): Promise<void> {
	if (!env.SESSION || !sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return;
	await env.SESSION.delete(`studio:session:${await tokenHash(sessionId)}`);
}

export function photoOriginFor(requestUrl: URL): string {
	if (requestUrl.hostname === "blog.kanouk.com") return "https://photos.kanouk.com";
	if (requestUrl.hostname === "blog-staging.kanouk.com") return "https://photos-staging.kanouk.com";
	return requestUrl.origin;
}

export function isAllowedPhotoHost(hostname: string): boolean {
	return hostname === "photos.kanouk.com" ||
		hostname === "photos-staging.kanouk.com" ||
		hostname === "localhost" ||
		hostname.endsWith(".workers.dev");
}

export function isSameOriginMutation(request: Request): boolean {
	const origin = request.headers.get("Origin");
	if (!origin) return false;
	try {
		return new URL(origin).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}
