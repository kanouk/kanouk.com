import base64
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = (
    Path(__file__).parents[1]
    / "scripts/cloudflare/provision_emdash_import_token_kanouk.py"
)
spec = importlib.util.spec_from_file_location("provision_emdash_import_token_kanouk", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(MODULE_PATH.parent))
assert spec.loader is not None
spec.loader.exec_module(module)


class EmDashImportTokenTest(unittest.TestCase):
    def test_generated_token_matches_emdash_hash_contract(self):
        raw, digest, prefix = module._generate_token()
        self.assertTrue(raw.startswith("ec_pat_"))
        self.assertEqual(prefix, raw[:11])
        expected = base64.urlsafe_b64encode(
            hashlib.sha256(raw.encode()).digest()
        ).decode().rstrip("=")
        self.assertEqual(digest, expected)

    def test_sql_literal_escapes_apostrophes(self):
        self.assertEqual(module._sql_literal("a'b"), "'a''b'")


if __name__ == "__main__":
    unittest.main()
