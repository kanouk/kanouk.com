// Small, dependency-free helpers for editing the published EmDash admin
// bundle. Every edit must match an exact anchor so that an upstream change
// stops `npm ci` instead of silently shipping a half-patched admin.

export class AdminPatchError extends Error {
  constructor(patchId, message) {
    super(
      `[emdash-admin:${patchId}] ${message}\n` +
        "Upstream EmDash changed this code. Re-check the extension point against " +
        "the new bundle (docs/emdash-upgrade.md) before updating the anchor.",
    );
    this.name = "AdminPatchError";
    this.patchId = patchId;
  }
}

function countOf(source, needle) {
  return source.split(needle).length - 1;
}

function preview(text) {
  const oneLine = JSON.stringify(text);
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/** Edits a source string; all edits for one extension point share an id. */
export function createEditor(patchId, source) {
  let current = source;
  const editor = {
    get source() {
      return current;
    },
    fail(message) {
      throw new AdminPatchError(patchId, message);
    },
    /** Replace an anchor that must occur exactly `count` times. */
    replace(before, after, count = 1) {
      const found = countOf(current, before);
      if (found !== count) {
        editor.fail(`expected ${count} match(es) of ${preview(before)}, found ${found}`);
      }
      current = current.split(before).join(after);
      return editor;
    },
    /** Insert `code` immediately before a unique anchor. */
    insertBefore(anchor, code) {
      return editor.replace(anchor, `${code}${anchor}`);
    },
    /**
     * Apply edits only inside one top-level function, from `startAnchor` up
     * to the next `endAnchor`. Keeps generic anchors (e.g. "children: [")
     * from matching an unrelated component.
     */
    within(startAnchor, endAnchor, edit) {
      if (countOf(current, startAnchor) !== 1) {
        editor.fail(`expected one scope start ${preview(startAnchor)}, found ${countOf(current, startAnchor)}`);
      }
      const start = current.indexOf(startAnchor);
      const end = current.indexOf(endAnchor, start + startAnchor.length);
      if (end < 0) editor.fail(`scope end ${preview(endAnchor)} not found after ${preview(startAnchor)}`);
      const scoped = createEditor(patchId, current.slice(start, end));
      edit(scoped);
      current = current.slice(0, start) + scoped.source + current.slice(end);
      return editor;
    },
  };
  return editor;
}
