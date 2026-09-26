// Shared runtime for the block editor extension points. Trusted plugin admin
// modules (descriptor `adminEntry`) may export `blockEditorExtensions`; the
// other patches read them through these helpers only.
//
// Extension shape (all members optional):
//   useModal(ctx)       React hook, called on every render of the plugin block
//                       dialog. ctx = { block, formValues, setFormValues,
//                       initialValues, defaultValues, ui: { Button, Input } }.
//                       Returns { onOpen(values), before, after, canSubmit,
//                       transformField(field), fieldAddon(props) } or null.
//   insertDefaults(ctx) Values prefilled when a block is inserted from the
//                       slash menu. ctx = { block, editor, insertPos, documentData }.
//   nodeView(ctx)       Summary of an inserted block. ctx = { blockType, id, data }.
//                       Returns { imageUrl, imageReferrerPolicy, title,
//                       externalUrl, below } or null.

export const RUNTIME_MARKER = "emdash-admin-extension-points:block-editor-runtime";

const RUNTIME = String.raw`/* ${RUNTIME_MARKER} */
const EMPTY_BLOCK_EDITOR_EXTENSIONS = [];
function collectBlockEditorExtensions(pluginAdmins) {
	const extensions = [];
	for (const pluginId of Object.keys(pluginAdmins ?? {}).sort()) {
		const exported = pluginAdmins[pluginId]?.blockEditorExtensions;
		if (!Array.isArray(exported)) continue;
		for (const extension of exported) if (extension && typeof extension === "object") extensions.push({ ...extension, pluginId });
	}
	return extensions.length > 0 ? extensions : EMPTY_BLOCK_EDITOR_EXTENSIONS;
}
function useBlockEditorExtensions() {
	const pluginAdmins = usePluginAdmins();
	return React$1.useMemo(() => collectBlockEditorExtensions(pluginAdmins), [pluginAdmins]);
}
function resolveBlockInsertDefaults(extensions, context) {
	let values;
	for (const extension of extensions) {
		const next = extension.insertDefaults?.(context);
		if (next && typeof next === "object" && Object.keys(next).length > 0) values = { ...values, ...next };
	}
	return values;
}
function resolveBlockNodeView(extensions, context) {
	const view = {};
	for (const extension of extensions) {
		const next = extension.nodeView?.(context);
		if (!next || typeof next !== "object") continue;
		for (const [key, value] of Object.entries(next)) {
			if (view[key] === void 0 && value !== void 0 && value !== null && value !== "") view[key] = value;
		}
	}
	return view;
}
`;

export default {
  id: "block-editor-runtime",
  summary: "Collects `blockEditorExtensions` exported by trusted plugin admin modules.",
  upstream:
    "Remove together with the block editor patches once EmDash exposes plugin hooks for the block dialog and node view.",
  apply(editor) {
    editor.insertBefore("function getPluginBlockDefaultValues(fields) {", RUNTIME);
    // The helpers rely on these admin internals.
    for (const dependency of ["function usePluginAdmins() {", "import * as React$1 from \"react\";"]) {
      if (!editor.source.includes(dependency)) editor.fail(`missing dependency ${dependency}`);
    }
  },
};
