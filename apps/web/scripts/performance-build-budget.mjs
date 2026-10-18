import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { init, parse } from 'es-module-lexer';
await init;
const root=resolve('dist/client/_astro');
const files=await readdir(root);
async function eagerBytes(entry, seen=new Set()) {
 const path=resolve(root,entry);
 if(seen.has(path)) return 0;
 assert.ok(path.startsWith(root+'/'));
 seen.add(path);
 const source=await readFile(path,'utf8');
 let bytes=gzipSync(source).length;
 for(const item of parse(source)[0]) {
  if(item.type==='static' && item.specifier?.startsWith('./')) bytes+=await eagerBytes(resolve(dirname(path),item.specifier),seen);
 }
 return bytes;
}
const registry=files.find(name=>/^PluginRegistry\..*\.js$/.test(name));
assert.ok(registry,'Admin entry must exist');
const admin=await eagerBytes(registry);
const cssGzip=async f=>gzipSync(await readFile(resolve(root,f))).length;
// The admin's own stylesheet (styles.*.css) is loaded only inside /_emdash/admin.
const isAdminCss=f=>/^styles\..*\.css$/.test(f);
const adminCss=(await Promise.all(files.filter(f=>f.endsWith('.css')&&isAdminCss(f)).map(cssGzip))).reduce((a,b)=>a+b,0);
const publicCss=(await Promise.all(files.filter(f=>f.endsWith('.css')&&!isAdminCss(f)).map(cssGzip))).reduce((a,b)=>a+b,0);
const performanceEntry=files.find(name=>name.startsWith('PagePerformance.') && name.endsWith('.js'));
assert.ok(performanceEntry,'Web vitals entry must exist');
const vitals=await eagerBytes(performanceEntry);
// Owner decision (2026-10-17): the admin is used only by the owner, so its
// budgets are loose guards against runaway growth; visitor-facing budgets are tight.
const budgets={admin:2000000,adminCss:80000,publicCss:32000,vitals:15000};
const result={adminEagerGzip:admin,adminCssGzip:adminCss,publicCssGzip:publicCss,publicVitalsGzip:vitals,budgets};
console.log(JSON.stringify(result));
// EmDash 0.40.1 admin itself is ~165 KB gzip larger than 0.35, and 1.1.0 pulls
// react-dom/client into the measured graph (docs/performance/README.md).
assert.ok(admin<=budgets.admin,'Admin eager JavaScript exceeds 2,000 KB gzip; check optional chart and icon imports');
assert.ok(adminCss<=budgets.adminCss,'Admin CSS exceeds 80 KB gzip');
assert.ok(publicCss<=budgets.publicCss,'Public-site CSS exceeds 32 KB gzip');
assert.ok(vitals<=15000,'Public measurement script exceeds 15 KB gzip');
