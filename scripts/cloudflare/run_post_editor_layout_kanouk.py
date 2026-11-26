#!/usr/bin/env python3
"""Apply the bounded post-editor-layout helper to pinned kanouk EmDash only.

Same guard as the related-album schema runner (pinned worker, active admin token,
--apply only with a verified D1 backup manifest and a receipt path); only the helper differs.
"""

from __future__ import annotations

from pathlib import Path
import sys


CLOUDFLARE_SCRIPTS = Path(__file__).resolve().parent
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

import run_related_album_schema_kanouk as guarded  # noqa: E402

guarded.HELPER_SCRIPT = guarded.WEB_ROOT / "scripts/ensure-post-editor-layout.mjs"


if __name__ == "__main__":
    raise SystemExit(guarded.main())
