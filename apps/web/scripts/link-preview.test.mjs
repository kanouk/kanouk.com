import assert from "node:assert/strict";
import test from "node:test";

const preview = await import("../plugins/yohaku-content-blocks/src/link-preview.ts");
const routeModule = await import("../plugins/yohaku-content-blocks/src/link-preview-route.ts");

class MemoryCache {
	values = new Map();
	async get(key) { return this.values.get(key) ?? null; }
	async set(key, value) { this.values.set(key, value); }
}

const publicDns = async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];

test("DoH uses Worker-compatible manual redirects and rejects redirect responses", async () => {
	const redirectModes = [];
	const resolver = preview.createPublicDnsResolver(async (input, init) => {
		redirectModes.push(init.redirect);
		const type = new URL(input).searchParams.get("type");
		return Response.json({
			Status: 0,
			Answer: type === "A"
				? [{ type: 1, data: "93.184.216.34" }]
				: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }],
		});
	});
	assert.deepEqual(await resolver("example.com", new AbortController().signal), [
		"93.184.216.34",
		"2606:2800:220:1:248:1893:25c8:1946",
	]);
	assert.deepEqual(redirectModes, ["manual", "manual"]);

	const redirecting = preview.createPublicDnsResolver(async () => new Response(null, {
		status: 302,
		headers: { Location: "https://attacker.example/dns" },
	}));
	await assert.rejects(
		redirecting("example.com", new AbortController().signal),
		(error) => error instanceof preview.LinkPreviewError && error.code === "SSRF_BLOCKED",
	);
});

test("rejects non-HTTPS, credentialed, port, IP, local and private-DNS targets before fetch", async () => {
	const inputs = [
		"http://example.com/",
		"https://user:pass@example.com/",
		"https://example.com:8443/",
		"https://127.0.0.1/",
		"https://localhost/",
		"https://service.internal/",
	];
	let fetches = 0;
	for (const input of inputs) {
		await assert.rejects(
			preview.getLinkPreview(input, new MemoryCache(), { fetch: async () => { fetches += 1; return new Response(); }, resolveDns: publicDns }),
			preview.LinkPreviewError,
		);
	}
	await assert.rejects(
		preview.getLinkPreview("https://rebinding.example.org/", new MemoryCache(), {
			fetch: async () => { fetches += 1; return new Response(); },
			resolveDns: async () => ["10.0.0.8"],
		}),
		(error) => error instanceof preview.LinkPreviewError && error.code === "SSRF_BLOCKED",
	);
	assert.equal(fetches, 0);
	assert.equal(preview.isPublicIpAddress("93.184.216.34"), true);
	assert.equal(preview.isPublicIpAddress("100.64.0.1"), false);
	assert.equal(preview.isPublicIpAddress("::ffff:127.0.0.1"), false);
	assert.equal(preview.isPublicIpAddress("::7f00:1"), false);
	assert.equal(preview.isPublicIpAddress("::ffff:0:7f00:1"), false);
	assert.equal(preview.isPublicIpAddress("64:ff9b::7f00:1"), false);
	assert.equal(preview.isPublicIpAddress("2001:db8::1"), false);
	assert.equal(preview.isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("revalidates every redirect, forwards no credentials, parses safe head metadata and caches it", async () => {
	const cache = new MemoryCache();
	const dnsHosts = [];
	const requests = [];
	const fetcher = async (url, init) => {
		requests.push({ url, init });
		if (url === "https://start.example.com/article") {
			return new Response(null, { status: 302, headers: { Location: "https://final.example.com/story" } });
		}
		return new Response(`<!doctype html><html><head>
			<base href="https://attacker.example/">
			<title>A &amp; B <b>story</b></title>
			<meta name="description" content="Plain &hellip; useful &lt;b&gt;text&lt;/b&gt;">
			<meta property="og:image" content="/images/card.jpg">
		</head><body>${"x".repeat(600_000)}</body></html>`, {
			status: 200,
			headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "700000" },
		});
	};
	const resolveDns = async (hostname) => { dnsHosts.push(hostname); return ["93.184.216.34"]; };
	const result = await preview.getLinkPreview("https://start.example.com/article#fragment", cache, { fetch: fetcher, resolveDns });

	assert.deepEqual(result, {
		url: "https://final.example.com/story",
		title: "A & B story",
		description: "Plain … useful text",
		imageUrl: "https://final.example.com/images/card.jpg",
	});
	assert.deepEqual(dnsHosts, ["start.example.com", "final.example.com", "final.example.com"]);
	assert.equal(requests.length, 2);
	for (const { init } of requests) {
		assert.equal(init.credentials, "omit");
		assert.equal(init.redirect, "manual");
		assert.equal(new Headers(init.headers).has("Cookie"), false);
		assert.equal(new Headers(init.headers).has("Authorization"), false);
	}

	const cached = await preview.getLinkPreview("https://start.example.com/article", cache, {
		fetch: async () => { throw new Error("cache miss"); },
		resolveDns: async () => { throw new Error("cache lookup must not resolve DNS"); },
	});
	assert.deepEqual(cached, result);
});

test("cache-only reads never fetch and expired cache records fail closed", async () => {
	const cache = new MemoryCache();
	let fetches = 0;
	assert.equal(await preview.getLinkPreview("https://cache.example.com/item", cache, {
		mode: "cache-only",
		fetch: async () => { fetches += 1; return new Response(); },
		resolveDns: publicDns,
	}), null);
	assert.equal(fetches, 0);

	const key = await preview.linkPreviewCacheKey("https://cache.example.com/item");
	cache.values.set(key, {
		version: 1,
		expiresAt: 99,
		metadata: { url: "https://cache.example.com/item", title: "Old", description: "", imageUrl: "" },
	});
	assert.equal(await preview.getCachedLinkPreview("https://cache.example.com/item", cache, () => 100), null);
});

test("fails closed when HTML head exceeds 512 KiB or MIME is not HTML", async () => {
	await assert.rejects(
		preview.getLinkPreview("https://large.example.com/item", new MemoryCache(), {
			fetch: async () => new Response(`<html><head>${"x".repeat(513 * 1024)}`, { headers: { "Content-Type": "text/html" } }),
			resolveDns: publicDns,
		}),
		(error) => error instanceof preview.LinkPreviewError && error.code === "TOO_LARGE",
	);
	await assert.rejects(
		preview.getLinkPreview("https://json.example.com/item", new MemoryCache(), {
			fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
			resolveDns: publicDns,
		}),
		(error) => error instanceof preview.LinkPreviewError && error.code === "UPSTREAM_ERROR",
	);
});

test("caps redirects at three and applies one abort budget across external work", async () => {
	let redirects = 0;
	await assert.rejects(
		preview.getLinkPreview("https://redirect.example.com/0", new MemoryCache(), {
			fetch: async (url) => {
				redirects += 1;
				const index = Number(new URL(url).pathname.slice(1));
				return new Response(null, { status: 302, headers: { Location: `https://redirect.example.com/${index + 1}` } });
			},
			resolveDns: publicDns,
		}),
		(error) => error instanceof preview.LinkPreviewError && error.code === "UPSTREAM_ERROR",
	);
	assert.equal(redirects, 4, "the initial request plus at most three followed redirects");

	await assert.rejects(
		preview.getLinkPreview("https://slow.example.com/item", new MemoryCache(), {
			fetch: async (_url, init) => new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			}),
			resolveDns: publicDns,
			timeoutMs: 5,
		}),
		(error) => error instanceof preview.LinkPreviewError && error.code === "TIMEOUT",
	);
});

test("omits an image whose hostname does not resolve only to public addresses", async () => {
	const result = await preview.getLinkPreview("https://page.example.com/item", new MemoryCache(), {
		fetch: async () => new Response('<html><head><title>Safe title</title><meta property="og:image" content="https://image.example.com/card.jpg"></head></html>', {
			headers: { "Content-Type": "text/html" },
		}),
		resolveDns: async (hostname) => hostname === "image.example.com" ? ["192.168.1.2"] : ["93.184.216.34"],
	});
	assert.equal(result.title, "Safe title");
	assert.equal(result.imageUrl, "");
});

test("own canonical links resolve only from current published CMS content and never stale network OGP", async () => {
	let published = true;
	let fetches = 0;
	const resolveInternal = async (url) => published ? {
		url,
		title: "Current CMS title",
		description: "Current summary",
		imageUrl: "https://blog.kanouk.com/_emdash/api/media/file/card.jpg",
	} : null;
	const result = await preview.getLinkPreview("https://blog.kanouk.com/posts/current", new MemoryCache(), {
		resolveInternal,
		fetch: async () => { fetches += 1; return new Response(); },
		resolveDns: publicDns,
	});
	assert.equal(result.title, "Current CMS title");
	assert.equal(result.imageUrl, "https://blog.kanouk.com/_emdash/api/media/file/card.jpg");
	assert.equal(fetches, 0);

	published = false;
	assert.equal(await preview.getLinkPreview("https://blog.kanouk.com/posts/current", new MemoryCache(), {
		resolveInternal,
		fetch: async () => { fetches += 1; return new Response("stale"); },
		resolveDns: publicDns,
	}), null);
	assert.equal(await preview.getLinkPreview("https://kanolog.net/unknown-old-post", new MemoryCache(), {
		resolveInternal,
		fetch: async () => { fetches += 1; return new Response("stale"); },
		resolveDns: publicDns,
	}), null);
	assert.equal(fetches, 0);
});

test("route is private editor-only POST and D1 reader uses the plugin KV namespace", async () => {
	const route = routeModule.createLinkPreviewRoutes(async () => null)["link-preview"];
	assert.equal(route.public, undefined);
	assert.equal(route.permission, "content:edit_any");
	await assert.rejects(
		route.handler({ request: new Request("https://blog.kanouk.com/route", { method: "GET" }) }),
		(error) => error?.status === 405,
	);
	await assert.rejects(
		route.handler({ request: new Request("https://blog.kanouk.com/route", { method: "POST" }), user: undefined }),
		(error) => error?.status === 401,
	);

	let boundName = "";
	const reader = preview.createD1LinkPreviewCacheReader({
		prepare(sql) {
			assert.equal(sql, "SELECT value FROM options WHERE name = ? LIMIT 1");
			return { bind(name) { boundName = name; return { async first() { return { value: JSON.stringify({ ok: true }) }; } }; } };
		},
	});
	assert.deepEqual(await reader.get("cache:key"), { ok: true });
	assert.equal(boundName, "plugin:yohaku-content-blocks:cache:key");
});

test("route applies a bounded per-user request rate", async () => {
	const route = routeModule.createLinkPreviewRoutes(async (url) => ({ url, title: "Title", description: "", imageUrl: "" }))["link-preview"];
	const values = new Map();
	const kv = {
		async get(key) { return values.get(key) ?? null; },
		async set(key, value) { values.set(key, value); },
	};
	const ctx = {
		request: new Request("https://blog.kanouk.com/route", { method: "POST" }),
		user: { id: "editor-1" },
		input: { url: "https://blog.kanouk.com/posts/current" },
		kv,
	};
	for (let index = 0; index < 30; index += 1) assert.equal((await route.handler(ctx)).title, "Title");
	await assert.rejects(route.handler(ctx), (error) => error?.status === 429);
});
