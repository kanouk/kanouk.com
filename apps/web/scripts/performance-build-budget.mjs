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
const css=(await Promise.all(files.filter(f=>f.endsWith('.css')).map(async f=>gzipSync(await readFile(resolve(root,f))).length))).reduce((a,b)=>a+b,0);
const performanceEntry=files.find(name=>name.startsWith('PagePerformance.') && name.endsWith('.js'));
assert.ok(performanceEntry,'Web vitals entry must exist');
const vitals=await eagerBytes(performanceEntry);
const result={adminEagerGzip:admin,allCssGzip:css,publicVitalsGzip:vitals,budgets:{admin:850000,css:70000,vitals:15000}};
console.log(JSON.stringify(result));
assert.ok(admin<=850000,'Admin eager JavaScript exceeds 850 KB gzip; check optional chart imports');
assert.ok(css<=70000,'CSS exceeds 70 KB gzip');
assert.ok(vitals<=15000,'Public measurement script exceeds 15 KB gzip');
