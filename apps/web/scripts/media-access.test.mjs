import assert from "node:assert/strict";
import test from "node:test";

const {
	applyMediaAccessHeaders,
	authenticationHeaders,
	authenticationProbeRequest,
	classifyMediaRead,
	deniedMediaResponse,
	mediaPreviewDelivery,
	publicMediaTransformationRequest,
	verifyAuthenticatedMediaRead,
} = await import("../src/studio/public-media-guard.ts");

const databaseWithoutPublicReference = {
	prepare() {
		return {
			bind() {
				return { first: async () => null };
			},
		};
	},
};

test("auth probe trusts only a protected auth/me 200, not cookie presence", async () => {
	let calls = 0;
	const anonymous = new Request("https://blog.kanouk.com/_emdash/api/media/file/draft.jpg");
	assert.equal(await verifyAuthenticatedMediaRead(anonymous, async () => {
		calls += 1;
		return new Response(null, { status: 200 });
	}), false);
	assert.equal(calls, 0);

	const forged = new Request("https://blog.kanouk.com/_emdash/api/media/file/draft.jpg", {
		headers: {
			Cookie: "astro-session=forged",
			"X-Untrusted-Internal-Bypass": "1",
		},
	});
	assert.equal(await verifyAuthenticatedMediaRead(forged, async (probe) => {
		calls += 1;
		assert.equal(new URL(probe.url).pathname, "/_emdash/api/auth/me");
		assert.equal(probe.headers.get("cookie"), "astro-session=forged");
		assert.equal(probe.headers.get("x-untrusted-internal-bypass"), null);
		return new Response(null, { status: 401 });
	}), false);
	assert.equal(calls, 1);

	const classification = await classifyMediaRead(forged, databaseWithoutPublicReference, {
		authenticate: (request) => verifyAuthenticatedMediaRead(
			request,
			async () => new Response(null, { status: 401 }),
		),
	});
	assert.equal(classification.access, "denied");
});

test("session and Bearer accepted by protected admin auth/me can authorize admin preview", async () => {
	for (const [header, expectedName, expectedValue] of [
		[{ Cookie: "astro-session=valid" }, "cookie", "astro-session=valid"],
		[{ Authorization: "Bearer valid-token" }, "authorization", "Bearer valid-token"],
	]) {
		const request = new Request("https://blog.kanouk.com/_emdash/api/media/file/draft.jpg", {
			headers: header,
		});
		const classification = await classifyMediaRead(request, databaseWithoutPublicReference, {
			authenticate: (candidate) => verifyAuthenticatedMediaRead(candidate, async (probe) => {
				assert.equal(probe.headers.get(expectedName), expectedValue);
				return Response.json({ success: true, data: { id: "admin" } });
			}),
		});
		assert.equal(classification.access, "authenticated");
	}
});

test("disabled-user response, probe errors, and non-200 success statuses fail closed", async () => {
	const request = new Request("https://blog.kanouk.com/_emdash/api/media/file/draft.jpg", {
		headers: { Cookie: "astro-session=stale" },
	});
	assert.equal(await verifyAuthenticatedMediaRead(
		request,
		async () => new Response(null, { status: 403 }),
	), false);
	assert.equal(await verifyAuthenticatedMediaRead(
		request,
		async () => new Response(null, { status: 204 }),
	), false);
	assert.equal(await verifyAuthenticatedMediaRead(
		request,
		async () => Response.json({ success: false, data: { id: "admin" } }),
	), false);
	assert.equal(await verifyAuthenticatedMediaRead(
		request,
		async () => Response.json({ success: true, data: {} }),
	), false);
	assert.equal(await verifyAuthenticatedMediaRead(request, async () => {
		throw new Error("dummy auth outage");
	}), false);
});

test("photo-host auth probes use the matching protected blog host", () => {
	for (const [sourceHost, expectedHost] of [
		["photos.kanouk.com", "blog.kanouk.com"],
		["photos-staging.kanouk.com", "blog-staging.kanouk.com"],
		["blog.kanouk.com", "blog.kanouk.com"],
	]) {
		const request = new Request(`https://${sourceHost}/_emdash/api/media/file/draft.jpg`, {
			headers: {
				Cookie: "astro-session=valid",
				Authorization: "Bearer valid-token",
				Accept: "image/*",
				"X-Extra": "drop-me",
			},
		});
		const probe = authenticationProbeRequest(request);
		assert.ok(probe);
		assert.equal(new URL(probe.url).hostname, expectedHost);
		assert.equal(new URL(probe.url).pathname, "/_emdash/api/auth/me");
		assert.deepEqual([...probe.headers.keys()].sort(), ["authorization", "cookie"]);
	}
});

test("authenticated direct-source reads copy only Cookie and Authorization", () => {
	const original = new Request("https://blog.kanouk.com/_yohaku/media/preview-v2/320/webp/draft.jpg", {
		headers: {
			Cookie: "astro-session=valid; theme=dark",
			Authorization: "Bearer valid-token",
			Referer: "https://example.test/private",
			"X-Internal-Bypass": "forged",
		},
	});
	const forwarded = authenticationHeaders(original);
	assert.equal(forwarded.get("cookie"), "astro-session=valid; theme=dark");
	assert.equal(forwarded.get("authorization"), "Bearer valid-token");
	assert.equal(forwarded.get("referer"), null);
	assert.equal(forwarded.get("x-internal-bypass"), null);
});

test("only public previews enter the credential-free image transformer", () => {
	assert.equal(mediaPreviewDelivery("public"), "transform-public");
	assert.equal(mediaPreviewDelivery("authenticated"), "direct-private");
	assert.equal(mediaPreviewDelivery("denied"), "deny");
	const transformedRequest = publicMediaTransformationRequest(
		new URL("https://blog.kanouk.com/_emdash/api/media/file/public.jpg"),
	);
	assert.deepEqual([...transformedRequest.headers.entries()], [["accept", "image/*"]]);
	assert.equal(transformedRequest.headers.get("cookie"), null);
	assert.equal(transformedRequest.headers.get("authorization"), null);
});

test("authenticated raw and preview responses are private while public variants stay cacheable", async () => {
	const transformed = new Response("dummy image", {
		status: 200,
		headers: {
			"Cache-Control": "public, max-age=31536000, immutable",
			Vary: "Accept-Encoding",
		},
	});
	const privatePreview = applyMediaAccessHeaders(transformed, "authenticated");
	assert.equal(privatePreview.headers.get("cache-control"), "private, no-store");
	assert.equal(privatePreview.headers.get("vary"), "Accept-Encoding, Cookie, Authorization");
	assert.equal(await privatePreview.text(), "dummy image");

	const publicPreview = new Response("public image", {
		headers: { "Cache-Control": "public, max-age=31536000, immutable" },
	});
	assert.equal(applyMediaAccessHeaders(publicPreview, "public"), publicPreview);
	assert.equal(publicPreview.headers.get("cache-control"), "public, max-age=31536000, immutable");

	const denied = deniedMediaResponse();
	assert.equal(denied.status, 404);
	assert.equal(denied.headers.get("cache-control"), "private, no-store");
	assert.equal(denied.headers.get("vary"), "Cookie, Authorization");
});
