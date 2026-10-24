import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverGuardedMedia, deliverOriginalImageFallback } from '../src/studio/media-delivery.ts';

const object = () => ({size:10,httpEtag:'"hash"',uploaded:new Date('2026-01-01'),
 writeHttpMetadata(headers){headers.set('Content-Type','image/png');headers.set('Cache-Control','public, max-age=999');}});
test('guarded R2 reads retain private caching, HEAD metadata and partial content',async()=>{
 const body=()=>({...object(),body:new Blob(['0123456789']).stream()});
 const bucket={head:async()=>object(),get:async(key,options)=>options.range.get('Range') ? {...body(),range:{offset:2,length:3},body:new Blob(['234']).stream()} : body()};
 const head=await deliverGuardedMedia(new Request('https://example.com/a',{method:'HEAD'}),bucket,'a');
 assert.equal(head.headers.get('Content-Length'),'10');assert.equal(await head.text(),'');
 const full=await deliverGuardedMedia(new Request('https://example.com/a'),bucket,'a');
 assert.equal(await full.text(),'0123456789');assert.equal(full.headers.get('Cache-Control'),'private, no-store');
 const part=await deliverGuardedMedia(new Request('https://example.com/a',{headers:{Range:'bytes=2-4'}}),bucket,'a');
 assert.equal(part.status,206);assert.equal(part.headers.get('Content-Range'),'bytes 2-4/10');assert.equal(await part.text(),'234');
});
test('guarded media handles missing objects and conditional reads without a body',async()=>{
 const missing=await deliverGuardedMedia(new Request('https://example.com/a'),{get:async()=>null},'a');
 assert.equal(missing.status,404);
 const notModified=await deliverGuardedMedia(new Request('https://example.com/a',{headers:{'If-None-Match':'"hash"'}}),{get:async()=>object()},'a');
 assert.equal(notModified.status,304);assert.equal(await notModified.text(),'');
 const failed=await deliverGuardedMedia(new Request('https://example.com/a',{headers:{'If-Match':'"old"'}}),{get:async()=>object()},'a');assert.equal(failed.status,412);
});
test('guarded media rejects impossible ranges and retains unsafe file isolation',async()=>{
 const bucket={head:async()=>object(),get:async()=>({...object(),body:new Blob(['svg']).stream(),writeHttpMetadata(h){h.set('Content-Type','image/svg+xml');}})};
 const invalid=await deliverGuardedMedia(new Request('https://example.com/a',{headers:{Range:'bytes=20-'}}),bucket,'a');
 assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Range'),'bytes */10');
 const svg=await deliverGuardedMedia(new Request('https://example.com/a'),bucket,'a');
 assert.equal(svg.headers.get('Content-Disposition'),'attachment');
 assert.match(svg.headers.get('Content-Security-Policy'),/sandbox/);
 const stale=await deliverGuardedMedia(new Request('https://example.com/a',{headers:{Range:'bytes=2-4','If-Range':'"old"'}}),bucket,'a');
 assert.equal(stale.status,200);
});

test('published image fallback serves the guarded original without pinning it to the derivative URL',async()=>{
 const bucket={get:async()=>({...object(),body:new Blob(['0123456789']).stream(),writeHttpMetadata(headers){headers.set('Content-Type','image/jpeg');}})};
 const fallback=await deliverOriginalImageFallback(
  new Request('https://photos.kanouk.com/_emdash/api/media/file/a'),
  bucket,
  'a',
 );
 assert.equal(fallback.status,200);
 assert.equal(fallback.headers.get('Content-Type'),'image/jpeg');
 assert.equal(fallback.headers.get('Cache-Control'),'private, no-store');
 assert.equal(fallback.headers.get('X-Yohaku-Image-Fallback'),'original');
 assert.equal(await fallback.text(),'0123456789');
});

test('published image fallback preserves a missing-original response',async()=>{
 const fallback=await deliverOriginalImageFallback(
  new Request('https://photos.kanouk.com/_emdash/api/media/file/missing'),
  {get:async()=>null},
  'missing',
 );
 assert.equal(fallback.status,404);
 assert.equal(fallback.headers.get('Cache-Control'),'private, no-store');
 assert.equal(fallback.headers.get('X-Yohaku-Image-Fallback'),'original');
});

test("stored photos are resized from R2 with the Images binding before the URL transform", async () => {
	const { readFile } = await import("node:fs/promises");
	const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	assert.match(wrangler, /"images": \{ "binding": "IMAGES" \}/);
	assert.match(worker, /\(await transformStoredImage\(request, env, context, mediaKey, width, format, quality, lookup\)\) \?\?\s*\(await transformImage\(/);
	assert.match(worker, /\.transform\(\{ width, fit: "scale-down" \}\)/);
	assert.match(worker, /"Cloudflare-CDN-Cache-Control": "public, max-age=31536000, immutable"/);
});

test("resized variants are stored in R2 once and reused only for the same original", async () => {
	const { readFile } = await import("node:fs/promises");
	const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	// Derived keys are never valid preview sources themselves.
	assert.match(worker, /mediaKey\.startsWith\(DERIVED_MEDIA_PREFIX\)/);
	// The stored variant and the original's ETag are looked up while the public-reference check runs.
	assert.match(worker, /const derivedPromise[\s\S]*const originalEtagPromise[\s\S]*await classifyMediaRead\(sourceRequest/);
	// A stored variant is served only when it was made from the current original.
	assert.match(worker, /derived\.customMetadata\?\.source === originalEtag/);
	// The variant is written back after the response is sent, keyed by the original's ETag.
	assert.match(worker, /context\.waitUntil\(\s*bucket\s*\.put\(derivedKey, bytes, \{[\s\S]*customMetadata: \{ source: object\.httpEtag \}/);
});

test("Leaflet's stylesheet is loaded on demand, not hoisted into every page", async () => {
	const { readFile } = await import("node:fs/promises");
	const [albumMap, viewer, style, admin] = await Promise.all([
		readFile(new URL("../src/components/AlbumMap.astro", import.meta.url), "utf8"),
		readFile(new URL("../src/client/photo-viewer.ts", import.meta.url), "utf8"),
		readFile(new URL("../src/client/map-style.ts", import.meta.url), "utf8"),
		readFile(new URL("../src/studio/admin.tsx", import.meta.url), "utf8"),
	]);
	assert.doesNotMatch(albumMap, /import\("leaflet\/dist\/leaflet\.css"\)/);
	assert.doesNotMatch(viewer, /import\("leaflet\/dist\/leaflet\.css"\)/);
	assert.doesNotMatch(admin, /import\("leaflet\/dist\/leaflet\.css"\)/);
	assert.match(admin, /loadMapStyle\(\)/);
	assert.match(albumMap, /loadMapStyle\(\)/);
	assert.match(viewer, /loadMapStyle\(\)/);
	assert.match(style, /from "leaflet\/dist\/leaflet\.css\?url"/);
});
