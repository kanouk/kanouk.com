// EmDash 0.35 bundles optional declarative charts into the main admin module.
// Keep the public API intact and load its renderer only when it is rendered.
export function deferAdminBlocks(source) {
 const original = 'import { BlockRenderer } from "@emdash-cms/blocks";';
 if (source.split(original).length !== 2) throw new Error('EmDash BlockRenderer import changed; review the deferred admin integration.');
 return source.replace(original, `const DeferredBlockRenderer = React.lazy(() => import("@emdash-cms/blocks").then(module => ({ default: module.BlockRenderer })));
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
