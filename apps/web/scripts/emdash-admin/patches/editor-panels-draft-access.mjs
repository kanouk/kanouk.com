// Trusted content editor panels (`contentEditorPanels`) gain:
//   supportsNew: true    also render on a new, unsaved entry
//   draftData            the entry's current, unsaved form data
//   onFieldChange(k, v)  write a field into that form data
// Upstream 0.40 offers draft access only to sandboxed panels on saved entries.

export default {
  id: "editor-panels-draft-access",
  summary: "Trusted editor panels on new entries, with draft read/write access.",
  upstream: "Remove when trusted panels support new entries and draft data upstream.",
  apply(editor) {
    editor.within("const ContentSettingsPanel = React$1.memo(function ContentSettingsPanel({", "\n});\n", (scope) => {
      scope.replace(
        "function ContentSettingsPanel({ collection, item, isNew, manifest, entryLocale, slug,",
        "function ContentSettingsPanel({ collection, item, isNew, manifest, entryLocale, draftData, onDraftFieldChange, slug,",
      );
      scope.replace(
        "\tconst trustedExtensionPanels = React$1.useMemo(() => !isNew && item ? resolveContentEditorPanels(pluginAdmins, collection, currentUser?.role ?? 0, manifest?.plugins) : [], [",
        "\tconst trustedExtensionPanels = React$1.useMemo(() => {\n\t\tconst resolved = resolveContentEditorPanels(pluginAdmins, collection, currentUser?.role ?? 0, manifest?.plugins);\n\t\treturn isNew || !item ? resolved.filter(({ extension }) => extension.supportsNew === true) : resolved;\n\t}, [",
      );
      // Sandboxed panels remain saved-entry only (their list is empty for new entries).
      scope.replace("\t\t\t\titem && extensionPanels.map(({ kind, pluginId, panel }) => {", "\t\t\t\textensionPanels.map(({ kind, pluginId, panel }) => {");
      scope.replace(
        `\t\t\t\t\t\t\t\t\tchildren: /* @__PURE__ */ jsx(Panel, {
\t\t\t\t\t\t\t\t\t\tcollection,
\t\t\t\t\t\t\t\t\t\tentry: item,
\t\t\t\t\t\t\t\t\t\tlocale: item.locale ?? entryLocale ?? void 0
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t}, \`\${collection}:\${item.id}\`)]`,
        `\t\t\t\t\t\t\t\t\tchildren: /* @__PURE__ */ jsx(Panel, {
\t\t\t\t\t\t\t\t\t\tcollection,
\t\t\t\t\t\t\t\t\t\tentry: item ?? void 0,
\t\t\t\t\t\t\t\t\t\tlocale: item?.locale ?? entryLocale ?? void 0,
\t\t\t\t\t\t\t\t\t\tdraftData,
\t\t\t\t\t\t\t\t\t\tonFieldChange: onDraftFieldChange
\t\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t\t})
\t\t\t\t\t\t\t}, \`\${collection}:\${item?.id ?? "new"}\`)]`,
      );
    });

    editor.within("function ContentEditor({ collection,", "\nfunction ", (scope) => {
      scope.within("jsx(ContentSettingsPanel, {", "})", (call) => {
        call.replace("\tisNew,\n\t\t\t\t\t\t\t\t\t\tmanifest,\n", "\tisNew,\n\t\t\t\t\t\t\t\t\t\tmanifest,\n\t\t\t\t\t\t\t\t\t\tdraftData: formData,\n\t\t\t\t\t\t\t\t\t\tonDraftFieldChange: handleFieldChange,\n");
      });
    });
  },
};
