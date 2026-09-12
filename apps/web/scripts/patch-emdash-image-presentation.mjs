// Pinned admin bundle compatibility: retain image presentation through both
// converters and TipTap's schema (unknown attrs are otherwise discarded).
export const IMAGE_PRESENTATION_MARKER = "emdash-kanouk-image-presentation-v11";
export function upgradeImagePresentation(source) {
  if (source.includes(IMAGE_PRESENTATION_MARKER)) return source;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Image presentation patch: expected one ${before}; review upstream bundle`);
    source = source.replace(before, after);
  };
  replace('alignment: { default: null }', 'alignment: { default: null },\n\t\t\tvisualStyle: { default: null },\n\t\t\tlink: { default: null }');
  replace('alignment: attrStr(attrs.alignment)', 'alignment: attrStr(attrs.alignment),\n\t\t\t\tvisualStyle: attrStr(attrs.visualStyle),\n\t\t\t\tlink: attrStr(attrs.link)');
  replace('alignment: imageBlock.alignment', 'alignment: imageBlock.alignment,\n\t\t\t\t\tvisualStyle: imageBlock.visualStyle,\n\t\t\t\t\tlink: imageBlock.link');
  return `/* ${IMAGE_PRESENTATION_MARKER} */\n${source}`;
}
