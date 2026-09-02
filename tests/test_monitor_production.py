from __future__ import annotations

from datetime import timedelta
import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = (
    Path(__file__).parents[1]
    / "scripts/migration/monitor_production.py"
)
SPEC = importlib.util.spec_from_file_location("monitor_production", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class MonitorProductionTests(unittest.TestCase):
    def test_checkpoint_due_uses_cutover_elapsed_time(self) -> None:
        self.assertFalse(
            module.checkpoint_due(
                "24h",
                module.CUTOVER_AT + timedelta(hours=23, minutes=59),
            )
        )
        self.assertTrue(
            module.checkpoint_due(
                "24h", module.CUTOVER_AT + timedelta(hours=24)
            )
        )
        self.assertTrue(
            module.checkpoint_due(
                "1w", module.CUTOVER_AT + timedelta(days=7)
            )
        )

    def test_worker_metrics_keep_disconnects_separate_from_errors(self) -> None:
        report = module.summarize_worker_metrics(
            [
                {
                    "sum": {
                        "requests": 12,
                        "errors": 0,
                        "subrequests": 3,
                    },
                    "dimensions": {"status": "success"},
                },
                {
                    "sum": {
                        "requests": 2,
                        "errors": 0,
                        "subrequests": 0,
                    },
                    "dimensions": {"status": "clientDisconnected"},
                },
            ]
        )
        self.assertEqual(report["requests"], 14)
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["statuses"]["clientDisconnected"], 2)
        self.assertEqual(report["error_rate_percent"], 0)

    def test_404_classification_separates_referrer_sources(self) -> None:
        report = module.classify_404_rows(
            [
                {
                    "path": "/definitely-missing-yohaku-monitor",
                    "hits": 4,
                    "referrer": "",
                },
                {
                    "path": "/broken",
                    "hits": 2,
                    "referrer": (
                        "https://blog.kanouk.com/posts/example"
                    ),
                },
                {
                    "path": "/old",
                    "hits": 3,
                    "referrer": "https://example.com/reference",
                },
            ]
        )
        self.assertEqual(report["hits"], 9)
        self.assertEqual(report["monitor_hits"], 4)
        self.assertEqual(
            [row["path"] for row in report["internal_referrer_rows"]],
            ["/broken"],
        )
        self.assertEqual(
            [row["path"] for row in report["external_referrer_rows"]],
            ["/old"],
        )


if __name__ == "__main__":
    unittest.main()
