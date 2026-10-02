// Ordered list of EmDash admin extension points. Each entry is generic: it
// opens a hook that plugins fill in (see plugins/yohaku-content-blocks/src/admin
// and src/studio/admin.tsx). Site-specific UI never lives in these patches.
//
// When upgrading EmDash, run `npm run emdash-admin:check`. A failing entry names
// the extension point to re-anchor, or to delete when upstream covers it.

import blockEditorRuntime from "./patches/block-editor-runtime.mjs";
import blockKitDependentSelect from "./patches/block-kit-dependent-select.mjs";
import blockModalExtensions from "./patches/block-modal-extensions.mjs";
import blockInsertDefaults from "./patches/block-insert-defaults.mjs";
import blockNodeViewExtensions from "./patches/block-node-view-extensions.mjs";
import editorPanelsDraftAccess from "./patches/editor-panels-draft-access.mjs";
import imagePresentationAttrs from "./patches/image-presentation-attrs.mjs";

/** The admin version these anchors were verified against. */
export const VERIFIED_ADMIN_VERSION = "1.1.0";

export const adminPatches = [
  blockEditorRuntime,
  blockKitDependentSelect,
  blockModalExtensions,
  blockInsertDefaults,
  blockNodeViewExtensions,
  editorPanelsDraftAccess,
  imagePresentationAttrs,
];
