// Inserted plugin block summary: `blockEditorExtensions[].nodeView` may
// provide a thumbnail, a title, the URL used by copy/open, and a preview
// rendered below the toolbar (the native edit/copy/delete UI is kept).

export default {
  id: "block-node-view-extensions",
  summary: "Lets trusted plugins enrich the inserted plugin block summary.",
  upstream: "Propose a node view summary hook for plugin blocks upstream.",
  apply(editor) {
    editor.within("function PluginBlockNodeView({ node, updateAttributes,", "\nfunction ", (scope) => {
      scope.replace(
        "\tconst hasFields = blockDef?.fields && blockDef.fields.length > 0;\n",
        "\tconst hasFields = blockDef?.fields && blockDef.fields.length > 0;\n\tconst blockNodeView = resolveBlockNodeView(useBlockEditorExtensions(), { blockType, id, data });\n\tconst blockExternalUrl = blockNodeView.externalUrl ?? id;\n",
      );
      scope.replace("\t\tnavigator.clipboard.writeText(id);", "\t\tnavigator.clipboard.writeText(blockExternalUrl);");
      scope.replace("\t\twindow.open(id, \"_blank\", \"noopener,noreferrer\");", "\t\twindow.open(blockExternalUrl, \"_blank\", \"noopener,noreferrer\");");
      scope.replace(
        "\tconst displayId = id ? getDisplayId(id, blockType) : Object.values(data).filter((v) => typeof v === \"string\" && v.length > 0 || typeof v === \"number\" && Number.isFinite(v)).map(String).join(\", \") || blockType;",
        "\tconst displayId = blockNodeView.title || (id ? getDisplayId(id, blockType) : Object.values(data).filter((v) => typeof v === \"string\" && v.length > 0 || typeof v === \"number\" && Number.isFinite(v)).map(String).join(\", \") || blockType);",
      );
      scope.replace(
        `\t\t\t\t\t\t\tclassName: cn("flex-shrink-0 w-10 h-10 rounded-lg bg-kumo-tint flex items-center justify-center", color),
\t\t\t\t\t\t\tchildren: /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" })`,
        `\t\t\t\t\t\t\tclassName: cn("flex-shrink-0 w-10 h-10 overflow-hidden rounded-lg bg-kumo-tint flex items-center justify-center", color),
\t\t\t\t\t\t\tchildren: blockNodeView.imageUrl ? /* @__PURE__ */ jsx("img", {
\t\t\t\t\t\t\t\tsrc: blockNodeView.imageUrl,
\t\t\t\t\t\t\t\talt: "",
\t\t\t\t\t\t\t\treferrerPolicy: blockNodeView.imageReferrerPolicy,
\t\t\t\t\t\t\t\tclassName: "h-full w-full object-cover"
\t\t\t\t\t\t\t}) : /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" })`,
      );
      scope.replace(
        "\t\t\t\t}), isEditing && /* @__PURE__ */ jsx(\"div\", {\n\t\t\t\t\tclassName: \"px-4 pb-3 pt-0\",",
        "\t\t\t\t}), blockNodeView.below ? /* @__PURE__ */ jsx(\"div\", { className: \"p-3\", children: blockNodeView.below }) : null, isEditing && /* @__PURE__ */ jsx(\"div\", {\n\t\t\t\t\tclassName: \"px-4 pb-3 pt-0\",",
      );
    });
  },
};
