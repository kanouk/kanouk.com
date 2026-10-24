// Runs the Worker's preview route against fake R2 / Images / D1 bindings:
// a variant is resized once, stored, and reused only for the same original.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./support/worker-test-loader.mjs", import.meta.url);
const { default: worker, derivedMediaKey } = await import("../src/worker.ts");

const KEY = "01PHOTO.jpg";
const ORIGINAL = new Uint8Array([1, 2, 3, 4]);

function bindings({ allowed = true, etag = '"etag-1"' } = {}) {
	const objects = new Map([[KEY, { bytes: ORIGINAL, httpEtag: etag, httpMetadata: { contentType: "image/jpeg" }, customMetadata: {} }]]);
	const calls = { transforms: 0, puts: [] };
	const bucket = {
		async get(key) {
			const object = objects.get(key);
			if (!object) return null;
			return { ...object, body: new Blob([object.bytes]).stream() };
		},
		async head(key) {
			const object = objects.get(key);
			return object ? { httpEtag: object.httpEtag } : null;
		},
		async put(key, value, options) {
			calls.puts.push(key);
			objects.set(key, { bytes: new Uint8Array(value), httpEtag: '"derived"', ...options });
		},
	};
	const images = {
		input: () => ({
			transform: () => ({
				output: async ({ format }) => {
					calls.transforms += 1;
					return { contentType: () => format, image: () => new Blob([new Uint8Array([9, 9])]).stream() };
				},
			}),
		}),
	};
	const database = { prepare: () => ({ bind: () => ({ first: async () => (allowed ? { allowed: 1 } : null) }) }) };
	const env = { MEDIA: bucket, IMAGES: images, DB: database };
	const pending = [];
	const context = { waitUntil: (promise) => pending.push(promise) };
	return { env, context, calls, objects, settle: () => Promise.all(pending) };
}

const previewUrl = `https://photos.kanouk.com/_yohaku/media/preview-v2/320/avif/${encodeURIComponent(KEY)}`;

test("a public variant is resized once, stored in R2 and then served from the store", async () => {
	const site = bindings();
	const first = await worker.fetch(new Request(previewUrl), site.env, site.context);
	assert.equal(first.status, 200);
	assert.equal(first.headers.get("X-Yohaku-Image-Source"), "resized");
	assert.equal(first.headers.get("Content-Type"), "image/avif");
	assert.equal(first.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
	assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([9, 9]));
	await site.settle();
	assert.deepEqual(site.calls.puts, [derivedMediaKey(KEY, 320, "avif", 62)]);
	assert.equal(site.objects.get(site.calls.puts[0]).customMetadata.source, '"etag-1"');

	const second = await worker.fetch(new Request(previewUrl), site.env, site.context);
	assert.equal(second.headers.get("X-Yohaku-Image-Source"), "stored");
	assert.equal(second.headers.get("Content-Type"), "image/avif");
	assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([9, 9]));
	assert.equal(site.calls.transforms, 1);

	const head = await worker.fetch(new Request(previewUrl, { method: "HEAD" }), site.env, site.context);
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
});

test("a stored variant made from a replaced original is resized again", async () => {
	const site = bindings();
	await worker.fetch(new Request(previewUrl), site.env, site.context);
	await site.settle();
	site.objects.get(KEY).httpEtag = '"etag-2"';
	const response = await worker.fetch(new Request(previewUrl), site.env, site.context);
	assert.equal(response.headers.get("X-Yohaku-Image-Source"), "resized");
	await site.settle();
	assert.equal(site.calls.transforms, 2);
	assert.equal(site.objects.get(derivedMediaKey(KEY, 320, "avif", 62)).customMetadata.source, '"etag-2"');
});

test("media that is not publicly referenced is denied before any variant is read or written", async () => {
	const site = bindings({ allowed: false });
	const response = await worker.fetch(new Request(previewUrl), site.env, site.context);
	assert.equal(response.status, 404);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	await site.settle();
	assert.equal(site.calls.transforms, 0);
	assert.deepEqual(site.calls.puts, []);
	const derived = await worker.fetch(new Request(`https://photos.kanouk.com/_yohaku/media/preview-v2/320/avif/${encodeURIComponent(derivedMediaKey(KEY, 320, "avif", 62))}`), site.env, site.context);
	assert.equal(derived.status, 404);
});

test("without the Images binding the stored variant is still ignored in favour of the URL transform path", async () => {
	const site = bindings();
	delete site.env.IMAGES;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("resized-by-url", { status: 200, headers: { "Content-Type": "image/avif" } });
	try {
		const response = await worker.fetch(new Request(previewUrl), site.env, site.context);
		assert.equal(await response.text(), "resized-by-url");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
