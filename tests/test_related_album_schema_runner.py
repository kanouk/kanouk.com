from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = (
    Path(__file__).parents[1]
    / "scripts/cloudflare/run_related_album_schema_kanouk.py"
)
SPEC = importlib.util.spec_from_file_location("run_related_album_schema_kanouk", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class RelatedAlbumSchemaRunnerTests(unittest.TestCase):
    def test_defaults_to_dry_run_and_pins_both_origins(self) -> None:
        command = runner.helper_command([])
        self.assertIn("--dry-run", command)
        self.assertEqual(command.count(runner.EXPECTED_URL), 2)
        self.assertEqual(command[-4:], [
            "--origin",
            runner.EXPECTED_URL,
            "--expected-origin",
            runner.EXPECTED_URL,
        ])

    def test_apply_requires_backup_and_new_receipt_paths(self) -> None:
        with self.assertRaisesRegex(runner.EmDashGuardError, "requires"):
            runner.normalized_args(["--apply"])
        args = runner.normalized_args([
            "--apply",
            "--backup-manifest",
            "/backup/manifest.json",
            "--receipt",
            "/receipts/related-album.json",
        ])
        self.assertEqual(args[0], "--apply")

    def test_blocks_origin_overrides_conflicting_modes_and_unknown_flags(self) -> None:
        for args in (
            ["--origin", "https://example.test"],
            ["--expected-origin", "https://example.test"],
            ["--dry-run", "--apply"],
            ["--delete"],
            ["--dry-run", "--receipt", "/tmp/receipt.json"],
        ):
            with self.subTest(args=args):
                with self.assertRaises(runner.EmDashGuardError):
                    runner.normalized_args(args)


if __name__ == "__main__":
    unittest.main()
