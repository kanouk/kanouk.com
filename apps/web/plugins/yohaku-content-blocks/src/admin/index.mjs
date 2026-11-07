// Admin entry of the yohaku-content-blocks plugin (descriptor `adminEntry`).
// EmDash loads it into the admin bundle; see the extension point contract in
// scripts/emdash-admin/patches/block-editor-runtime.mjs.
import { blockEditorExtensions as blockExtensions } from "./block-editors.mjs";
import { imageStyleExtension } from "./image-style.mjs";

export const blockEditorExtensions = [...blockExtensions, imageStyleExtension];
