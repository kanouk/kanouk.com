from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock


SCRIPTS = Path(__file__).parents[1] / "scripts/cloudflare"
sys.path.insert(0, str(SCRIPTS))
try:
    SPEC = importlib.util.spec_from_file_location(
        "run_product_card_backfill_kanouk", SCRIPTS / "run_product_card_backfill_kanouk.py"
    )
    assert SPEC and SPEC.loader
    runner = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(runner)
finally:
    sys.path.pop(0)


class ProductCardBackfillRunnerTests(unittest.TestCase):
    def test_passes_existing_scoped_environment_only_after_preflight(self) -> None:
        env = {"EMDASH_TOKEN": "ec_pat_test", "EMDASH_URL": "https://pinned.test"}
        with (
            patch.object(runner, "load_credential", return_value={}) as load,
            patch.object(runner, "child_environment", return_value=env),
            patch.object(runner, "preflight") as preflight,
            patch.object(runner.subprocess, "run", return_value=Mock(returncode=0)) as run,
            patch.object(sys, "argv", ["runner", "--dry-run", "--content-id", "selected"]),
        ):
            self.assertEqual(runner.main(), 0)
            load.assert_called_once_with()
            preflight.assert_called_once_with(env)
            self.assertEqual(run.call_args.args[0], [
                "node", str(runner.BACKFILL_SCRIPT), "--dry-run", "--content-id", "selected"
            ])
            self.assertEqual(run.call_args.kwargs["env"], env)

    def test_failed_preflight_never_starts_repair(self) -> None:
        with (
            patch.object(runner, "load_credential", return_value={}),
            patch.object(runner, "child_environment", return_value={}),
            patch.object(runner, "preflight", side_effect=runner.EmDashGuardError("blocked")),
            patch.object(runner.subprocess, "run") as run,
        ):
            self.assertEqual(runner.main(), 2)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
