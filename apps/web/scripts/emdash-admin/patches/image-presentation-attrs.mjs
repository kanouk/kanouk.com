// Keep the image block's `visualStyle` through both Portable Text converters
// and the TipTap schema (unknown attrs are otherwise discarded).
// `link` is native since EmDash 0.40 and stored as `{ href, blank? }`; the
// public renderer accepts that and the legacy string form.

export default {
  id: "image-presentation-attrs",
  summary: "Preserves the image visualStyle attribute in the editor round trip.",
  upstream: "Propose passthrough of unknown image block attributes upstream.",
  apply(editor) {
    editor.replace("\t\t\talignment: { default: null },\n\t\t\tlink: { default: null }", "\t\t\talignment: { default: null },\n\t\t\tvisualStyle: { default: null },\n\t\t\tlink: { default: null }");
    editor.replace("\t\t\t\talignment: attrStr(attrs.alignment),\n\t\t\t\tlink\n", "\t\t\t\talignment: attrStr(attrs.alignment),\n\t\t\t\tvisualStyle: attrStr(attrs.visualStyle),\n\t\t\t\tlink\n");
    editor.replace("\t\t\t\t\talignment: imageBlock.alignment,\n\t\t\t\t\tlink: normalizeImageLink(imageBlock.link)", "\t\t\t\t\talignment: imageBlock.alignment,\n\t\t\t\t\tvisualStyle: imageBlock.visualStyle,\n\t\t\t\t\tlink: normalizeImageLink(imageBlock.link)");
  },
};
