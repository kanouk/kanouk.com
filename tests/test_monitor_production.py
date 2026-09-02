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
                {
                    "path": "/open/visitors/info/gets",
                    "hits": 1,
                    "referrer": "https://photos.kanouk.com/",
                },
            ]
        )
        self.assertEqual(report["hits"], 10)
        self.assertEqual(report["monitor_hits"], 4)
        self.assertEqual(
            [row["path"] for row in report["internal_referrer_rows"]],
            ["/broken"],
        )
        self.assertEqual(
            [row["path"] for row in report["external_referrer_rows"]],
            ["/old"],
        )
        self.assertEqual(
            [row["path"] for row in report["legacy_client_rows"]],
            ["/open/visitors/info/gets"],
        )

    def test_ga4_report_keeps_host_level_metrics(self) -> None:
        report = module.summarize_ga4_report(
            {
                "rows": [
                    {
                        "dimensionValues": [{"value": "blog.kanouk.com"}],
                        "metricValues": [{"value": "8"}, {"value": "3"}],
                    },
                    {
                        "dimensionValues": [{"value": "kanolog.net"}],
                        "metricValues": [{"value": "21"}, {"value": "19"}],
                    },
                ]
            }
        )
        self.assertEqual(report["production_hosts_observed"], ["blog.kanouk.com"])
        self.assertEqual(
            report["production_rows"][0],
            {
                "host_name": "blog.kanouk.com",
                "screen_page_views": 8,
                "active_users": 3,
            },
        )

    def test_search_console_summary_finds_domain_property(self) -> None:
        report = module.summarize_search_console_sites(
            {
                "siteEntry": [
                    {
                        "siteUrl": "sc-domain:kanouk.com",
                        "permissionLevel": "siteOwner",
                    }
                ]
            }
        )
        self.assertEqual(
            report["target_site"],
            {
                "site_url": "sc-domain:kanouk.com",
                "permission_level": "siteOwner",
            },
        )

    def test_platform_usage_summarizes_d1_and_r2_without_identity(self) -> None:
        report = module.summarize_platform_usage(
            {
                "accountName": "must not leak",
                "d1AnalyticsAdaptiveGroups": [
                    {
                        "sum": {
                            "readQueries": 10,
                            "writeQueries": 2,
                            "rowsRead": 100,
                            "rowsWritten": 3,
                            "queryBatchResponseBytes": 2048,
                        }
                    },
                    {
                        "sum": {
                            "readQueries": 4,
                            "writeQueries": 1,
                            "rowsRead": 20,
                            "rowsWritten": 2,
                            "queryBatchResponseBytes": 512,
                        }
                    },
                ],
                "d1StorageAdaptiveGroups": [
                    {
                        "max": {"databaseSizeBytes": 76337150},
                        "dimensions": {"date": "2026-09-02"},
                    }
                ],
                "r2OperationsAdaptiveGroups": [
                    {
                        "sum": {"requests": 8},
                        "dimensions": {
                            "actionType": "GetObject",
                            "actionStatus": "success",
                            "responseStatusCode": 200,
                        },
                    }
                ],
                "r2StorageAdaptiveGroups": [
                    {
                        "max": {
                            "objectCount": 3546,
                            "payloadSize": 6978619128,
                            "metadataSize": 102348,
                            "uploadCount": 0,
                        },
                        "dimensions": {"date": "2026-09-02"},
                    }
                ],
            }
        )
        self.assertEqual(report["d1"]["read_queries"], 14)
        self.assertEqual(report["d1"]["rows_read"], 120)
        self.assertEqual(
            report["d1_storage"]["database_size_bytes"], 76337150
        )
        self.assertEqual(report["r2_request_count"], 8)
        self.assertEqual(report["r2_storage"]["object_count"], 3546)
        self.assertNotIn("accountName", report)

    def test_cost_baseline_keeps_floor_separate_from_unknown_invoice(self) -> None:
        report = module.build_cost_baseline(
            {"requests": 23_243},
            {
                "d1": {"rows_read": 11_041_025, "rows_written": 7_268},
                "d1_storage": {"database_size_bytes": 76_337_150},
                "r2_operations": [
                    {"action_type": "ListObjects", "requests": 18},
                    {"action_type": "GetObject", "requests": 187},
                    {"action_type": "HeadBucket", "requests": 24},
                ],
                "r2_storage": {"payload_bytes": 6_978_619_128},
            },
        )
        self.assertTrue(
            report[
                "all_measured_or_bounded_yohaku_usage_below_included_units"
            ]
        )
        self.assertEqual(report["minimum_account_cost_usd_year"], 60.0)
        self.assertEqual(
            report["savings_ceiling_before_unknown_overages_usd_year"], 40.0
        )
        self.assertEqual(
            report["observations"]["r2_class_a_operations"]["used"], 18
        )
        self.assertEqual(
            report["observations"]["r2_class_b_operations"]["used"], 211
        )
        self.assertEqual(report["estimate_status"], "provisional_floor_only")
        self.assertIn("Workers CPU time and CPU overage", report["unknowns"])

    def test_billing_summary_omits_account_identity(self) -> None:
        report = module.summarize_cloudflare_billing_rows(
            [
                {
                    "BillingAccountName": "Private account name",
                    "ChargePeriodStart": "2026-09-01T00:00:00Z",
                    "ChargePeriodEnd": "2026-09-02T00:00:00Z",
                    "ConsumedQuantity": 100,
                    "ConsumedUnit": "Requests",
                    "BilledCost": 0,
                    "BillingCurrency": "USD",
                    "x_ProductFamilyName": "Workers",
                    "x_BillableMetricName": "Workers Standard Requests",
                }
            ]
        )
        self.assertEqual(report["product_families"], ["Workers"])
        self.assertTrue(report["cost_fields_present"])
        self.assertNotIn("BillingAccountName", report["records"][0])


if __name__ == "__main__":
    unittest.main()
