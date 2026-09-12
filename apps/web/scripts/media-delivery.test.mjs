import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverGuardedMedia } from '../src/studio/media-delivery.ts';

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
