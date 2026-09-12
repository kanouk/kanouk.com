interface GuardedMediaObject {
 size:number; httpEtag:string; uploaded:Date;
 writeHttpMetadata(headers:Headers):void;
 body?:ReadableStream<Uint8Array>;
 range?:{offset?:number;length?:number;suffix?:number};
}
export interface GuardedMediaBucket {
 head(key:string):Promise<GuardedMediaObject|null>;
 get(key:string,options:{onlyIf:Headers;range:Headers}):Promise<GuardedMediaObject|null>;
}
const SAFE_INLINE_TYPES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/avif','image/x-icon','video/mp4','video/webm','audio/mpeg','audio/wav','audio/ogg']);

/** Called only after the current live reference / authentication guard succeeds. */
export async function deliverGuardedMedia(request: Request, bucket: GuardedMediaBucket, key: string): Promise<Response> {
 const headers = new Headers({
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'strict-origin-when-cross-origin',
  'Accept-Ranges':'bytes',
 });
 const readHeaders = new Headers(request.headers);
 if (request.method !== 'HEAD' && readHeaders.has('Range')) {
  const metadata = await bucket.head(key);
  if (!metadata) return new Response('Not Found',{status:404,headers});
  const ifRange = readHeaders.get('If-Range');
  if (ifRange && ifRange !== metadata.httpEtag && Date.parse(ifRange) < metadata.uploaded.getTime()) readHeaders.delete('Range');
  if (ifRange && ifRange !== metadata.httpEtag && !Number.isFinite(Date.parse(ifRange))) readHeaders.delete('Range');
  const range = readHeaders.get('Range');
  if (range) {
   const match = /^bytes=(\d*)-(\d*)$/.exec(range);
   if (!match || (!match[1] && !match[2])) readHeaders.delete('Range');
   else if ((match[1] && Number(match[1]) >= metadata.size) || (!match[1] && Number(match[2]) === 0) || (match[1] && match[2] && Number(match[1]) > Number(match[2]))) {
    headers.set('Content-Range',`bytes */${metadata.size}`);
    return new Response(null,{status:416,headers});
   }
  }
 }
 const object = request.method === 'HEAD'
  ? await bucket.head(key)
  : await bucket.get(key, {onlyIf:readHeaders, range:readHeaders});
 if (!object) return new Response('Not Found',{status:404,headers});
 object.writeHttpMetadata(headers);
 // HTTP metadata must not loosen the access boundary after the guard.
 headers.set('Cache-Control','private, no-store');
 headers.set('Content-Type',headers.get('Content-Type') || 'application/octet-stream');
 headers.set('Content-Disposition',SAFE_INLINE_TYPES.has(headers.get('Content-Type')!) ? 'inline' : 'attachment');
 headers.set('Content-Security-Policy',"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
 headers.set('ETag',object.httpEtag);
 headers.set('Last-Modified',object.uploaded.toUTCString());
 if (request.method === 'HEAD') {
  headers.set('Content-Length',String(object.size));
  return new Response(null,{headers});
 }
 if (!object.body) {
  return new Response(null,{status:request.headers.has('If-Match') || request.headers.has('If-Unmodified-Since') ? 412 : 304,headers});
 }
 let status=200;
 if (object.range && readHeaders.has('Range')) {
  const range=object.range;
  const offset=range.suffix !== undefined ? Math.max(0,object.size-range.suffix) : range.offset ?? 0;
  const length='length' in range ? range.length ?? object.size-offset : object.size-offset;
  headers.set('Content-Range',`bytes ${offset}-${offset+length-1}/${object.size}`);
  headers.set('Content-Length',String(length));
  status=206;
 } else headers.set('Content-Length',String(object.size));
 return new Response(object.body,{status,headers});
}
