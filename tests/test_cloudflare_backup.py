from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/backup_cloudflare_staging.py"
SPEC = importlib.util.spec_from_file_location("backup_cloudflare_staging", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class CloudflareBackupTests(unittest.TestCase):
    def test_json_writer_is_atomic_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            module.write_json_atomic(path, {"ok": True})
            self.assertEqual(path.read_text(), '{\n  "ok": true\n}\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
