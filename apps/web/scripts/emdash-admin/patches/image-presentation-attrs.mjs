// Keep the image block's `visualStyle` through both Portable Text converters
// and the TipTap schema, and expose the image toolbar and preview to plugins.
// `link` is native since EmDash 0.40 and stored as `{ href, blank? }`; the
// public renderer accepts that and the legacy string form.

export default {
  id: "image-presentation-attrs",
  summary: "Preserves image presentation and exposes image editing hooks.",
  upstream: "Propose image attribute passthrough and toolbar/preview hooks upstream.",
  apply(editor) {
    editor.replace("\t\t\talignment: { default: null },\n\t\t\tlink: { default: null }", "\t\t\talignment: { default: null },\n\t\t\tvisualStyle: { default: null },\n\t\t\tlink: { default: null }");
    editor.replace("\t\t\t\talignment: attrStr(attrs.alignment),\n\t\t\t\tlink\n", "\t\t\t\talignment: attrStr(attrs.alignment),\n\t\t\t\tvisualStyle: attrStr(attrs.visualStyle),\n\t\t\t\tlink\n");
    editor.replace("\t\t\t\t\talignment: imageBlock.alignment,\n\t\t\t\t\tlink: normalizeImageLink(imageBlock.link)", "\t\t\t\t\talignment: imageBlock.alignment,\n\t\t\t\t\tvisualStyle: imageBlock.visualStyle,\n\t\t\t\t\tlink: normalizeImageLink(imageBlock.link)");
    editor.within("function ImageBubbleMenu({ editor, appendTo,", "\nfunction ", (scope) => {
      scope.insertBefore("\tconst menuRef = React$1.useRef(null);", "\tconst imageExtensions = useBlockEditorExtensions();\n");
      scope.insertBefore("\t\t\t\talt: typeof attrs?.alt", "\t\t\t\tvisualStyle: attrs?.visualStyle ?? null,\n");
      scope.replace(
        'if (!(event.target instanceof HTMLInputElement)) event.preventDefault();',
        'if (!(event.target instanceof HTMLInputElement || event.target.closest?.("select"))) event.preventDefault();',
      );
      const endOfControls = "\n\t\t\t\t] })\n\t\t\t}, controlsKey)";
      scope.insertBefore(
        endOfControls,
        `,\n\t\t\t\t\timageExtensions.map(({ pluginId, ImageToolbar }, index) => ImageToolbar ? jsx(ImageToolbar, {
\t\t\t\t\t\timage,
\t\t\t\t\t\tupdateAttributes: (attrs) => {
\t\t\t\t\t\t\tif (editor.isEditable && getSelectedImage(editor.state)) editor.commands.updateAttributes("image", attrs);
\t\t\t\t\t\t}
\t\t\t\t\t}, pluginId + ":" + index) : null)`,
      );
    });
    editor.within("function ImageNodeView({ node, updateAttributes,", "\nconst ", (scope) => {
      scope.insertBefore(
        "\tconst storedSrc =",
        "\tconst imagePreviewClass = useBlockEditorExtensions().map((extension) => extension.imagePreviewClass?.(node.attrs)).filter(Boolean).join(\" \");\n",
      );
      scope.replace(
        'className: "rounded-lg max-w-full h-auto object-cover",',
        'className: cn("max-w-full h-auto object-cover", imagePreviewClass || "rounded-lg"),',
      );
    });
  },
};
