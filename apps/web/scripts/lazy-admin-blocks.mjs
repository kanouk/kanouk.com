import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// EmDash bundles optional declarative charts into the main admin module.
// Keep the public API intact and load its renderer only when it is rendered.
// Other helpers from the same import come from the renderer-free `/server`
// entry so they do not pull the renderer back into the eager chunk.
const BLOCKS_IMPORT = /import \{([^}]+)\} from "@emdash-cms\/blocks";/g;

function serverExports() {
 const require = createRequire(import.meta.url);
 const entry = require.resolve('@emdash-cms/blocks').replace(/index\.js$/, 'server.js');
 const source = readFileSync(entry, 'utf8');
 const list = source.slice(source.lastIndexOf('export {') + 8, source.lastIndexOf('}'));
 return new Set(list.split(',').map((name) => name.trim().split(/\s+as\s+/).pop()).filter(Boolean));
}

export function deferAdminBlocks(source, available = serverExports()) {
 const imports = [...source.matchAll(BLOCKS_IMPORT)];
 if (imports.length !== 1) throw new Error('EmDash @emdash-cms/blocks import changed; review the deferred admin integration.');
 const [statement, specifiers] = imports[0];
 const names = specifiers.split(',').map((name) => name.trim()).filter(Boolean);
 if (!names.includes('BlockRenderer')) throw new Error('EmDash BlockRenderer import changed; review the deferred admin integration.');
 const helpers = names.filter((name) => name !== 'BlockRenderer');
 const missing = helpers.filter((name) => !available.has(name.split(/\s+as\s+/)[0]));
 if (missing.length) throw new Error(`@emdash-cms/blocks/server lacks ${missing.join(', ')}; review the deferred admin integration.`);
 const helperImport = helpers.length ? `import { ${helpers.join(', ')} } from "@emdash-cms/blocks/server";\n` : '';
 return source.replace(statement, `${helperImport}const DeferredBlockRenderer = React.lazy(() => import("@emdash-cms/blocks").then(module => ({ default: module.BlockRenderer })));
function BlockRenderer(props) {
 return React.createElement(React.Suspense, { fallback: React.createElement("p", { role: "status" }, "読み込み中…") },
  React.createElement(DeferredBlockRenderer, props));
}`);
}
export function lazyAdminBlocks() {
 return {
  name: 'yohaku-defer-admin-blocks',
  enforce: 'pre',
  apply: 'build',
  transform(source, id) {
   if (!id.replaceAll('\\\\','/').endsWith('/@emdash-cms/admin/dist/index.js')) return;
   return { code: deferAdminBlocks(source), map: null };
  },
 };
}
