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
function directImport(name, alias) {
 const target=exports.get(name);
 if(!target)throw new Error('Review Phosphor export: '+name);
 return `import { ${target.name} as ${alias} } from "${target.path}";`;
}
// EmDash 0.40 imports the whole icon namespace for a handful of static
// `Icons.Name` reads. Keep that API, but only with the icons actually used.
export function directPhosphorNamespace(code) {
 return code.replace(/import\s*\*\s*as\s+([\w$]+)\s+from\s*["']@phosphor-icons\/react["'];?/g,(_all,namespace)=>{
  const escaped=namespace.replace(/\$/g,'\\$');
  if(new RegExp(`(?<![\\w$.])${escaped}\\s*\\[`).test(code) || new RegExp(`(?<![\\w$.])${escaped}(?!\\s*\\.)(?![\\w$])`).test(code.replace(_all,'')))
   throw new Error(`Review dynamic use of the Phosphor namespace ${namespace}`);
  const names=[...new Set([...code.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\.([A-Za-z_$][\\w$]*)`,'g'))].map(match=>match[1]))].sort();
  const members=names.map(name=>`${name}: ${namespace}$${name}`).join(', ');
  return `${names.map(name=>directImport(name,`${namespace}$${name}`)).join('\n')}\nconst ${namespace} = Object.freeze({ ${members} });`;
 });
}
export function directPhosphorImports(code) {
 return directPhosphorNamespace(code).replace(/import\s*\{([^}]+)\}\s*from\s*["']@phosphor-icons\/react["'];?/g,(_all,specifiers)=>
  specifiers.split(',').filter(spec=>spec.trim()).map(spec=>{
   const [name,alias=name]=spec.trim().split(/\s+as\s+/);
   if(name.startsWith('type '))return '';
   return directImport(name,alias);
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
