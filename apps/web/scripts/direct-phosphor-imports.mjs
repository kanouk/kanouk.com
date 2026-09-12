import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const source=readFileSync(require.resolve('@phosphor-icons/react').replace('index.cjs.js','index.es.js'),'utf8');
const locals=new Map(), exports=new Map();
for(const match of source.matchAll(/import \{([^}]+)\} from "([^"]+)";/g)) {
 for(const spec of match[1].split(',')) {
  const [name, alias=name]=spec.trim().split(/\s+as\s+/);
  locals.set(alias,{name,path:'@phosphor-icons/react/dist/'+match[2].replace(/^\.\//,'').replace(/\.es\.js$/,'')});
 }
}
for(const spec of source.slice(source.lastIndexOf('export {')+8).split(',')) {
 const [local, exported=local]=spec.trim().replace(/};\s*$/,'').split(/\s+as\s+/);
 if(locals.has(local))exports.set(exported,locals.get(local));
}
export function directPhosphorImports(code) {
 return code.replace(/import\s*\{([^}]+)\}\s*from\s*["']@phosphor-icons\/react["'];?/g,(_all,specifiers)=>
  specifiers.split(',').filter(spec=>spec.trim()).map(spec=>{
   const [name,alias=name]=spec.trim().split(/\s+as\s+/);
   if(name.startsWith('type '))return '';
   const target=exports.get(name);
   if(!target)throw new Error('Review Phosphor export: '+name);
   return `import { ${target.name} as ${alias} } from "${target.path}";`;
  }).join('\n'));
}
export function directPhosphor() {
 return {name:'yohaku-direct-phosphor-imports',enforce:'pre',apply:'build',
  transform(code,id) {
   if(!/\.[cm]?[jt]sx?$/.test(id) || !code.includes('@phosphor-icons/react'))return;
   const rewritten=directPhosphorImports(code);
   if(rewritten!==code)return {code:rewritten,map:null};
  }};
}
