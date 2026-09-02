#!/usr/bin/env python3
"""Collect a repeatable, read-only production checkpoint for Yohaku.

The report intentionally separates directly observed infrastructure and public
site health from Google-side state that must be checked through GA4/Search
Console. Cloudflare credentials are loaded through the kanouk.com account guard
and are never written to the report.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "apps/web"
CLOUDFLARE_SCRIPT_ROOT = REPO_ROOT / "scripts/cloudflare"
if str(CLOUDFLARE_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPT_ROOT))

from run_wrangler_kanouk import (  # noqa: E402
    WRANGLER_BIN,
    child_environment,
    load_credential,
    preflight,
)


CUTOVER_AT = datetime.fromisoformat("2026-09-02T06:53:55+09:00")
ZONE_ID = "929ba1aeb538cc8977baca490e55351a"
ZONE_NAME = "kanouk.com"
WORKER_SERVICE = "kanouk-emdash-staging"
DATABASE_NAME = "kanouk-content-staging"
PRODUCTION_HOSTS = ("blog.kanouk.com", "photos.kanouk.com")
STAGING_URL = "https://kanouk-emdash-staging.kanouk.workers.dev"
GA4_PROPERTY_ID = "256487934"
SEARCH_CONSOLE_SITE = "sc-domain:kanouk.com"
LEGACY_CLIENT_PATH_PREFIXES = ("/open/",)
CHECKPOINT_SECONDS = {
    "interim": 0,
    "24h": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
    "1mo": 30 * 24 * 60 * 60,
    "3mo": 90 * 24 * 60 * 60,
}


class MonitorError(RuntimeError):
    pass


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def checkpoint_due(checkpoint: str, observed_at: datetime) -> bool:
    elapsed = (
        observed_at.astimezone(timezone.utc)
        - CUTOVER_AT.astimezone(timezone.utc)
    ).total_seconds()
    return elapsed >= CHECKPOINT_SECONDS[checkpoint]


def cloudflare_json(
    path: str,
    *,
    token: str,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(
        "https://api.cloudflare.com/client/v4" + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        raise MonitorError(
            f"Cloudflare API request failed: {type(error).__name__}"
        ) from error
    if not isinstance(result, dict):
        raise MonitorError("Cloudflare API returned a non-object response")
    if path != "/graphql" and result.get("success") is not True:
        raise MonitorError("Cloudflare API reported an unsuccessful response")
    return result


def summarize_cloudflare_billing_rows(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    usage_rows = [
        {
            "charge_period_start": row.get("ChargePeriodStart"),
            "charge_period_end": row.get("ChargePeriodEnd"),
            "product_family": row.get("x_ProductFamilyName"),
            "metric": row.get("x_BillableMetricName"),
            "consumed_quantity": row.get("ConsumedQuantity"),
            "consumed_unit": row.get("ConsumedUnit"),
            "billed_cost": row.get("BilledCost"),
            "effective_cost": row.get("EffectiveCost"),
            "list_cost": row.get("ListCost"),
            "billing_currency": row.get("BillingCurrency"),
        }
        for row in rows
    ]
    return {
        "records": usage_rows,
        "record_count": len(usage_rows),
        "product_families": sorted(
            {
                str(row["product_family"])
                for row in usage_rows
                if row["product_family"]
            }
        ),
        "cost_fields_present": any(
            row["billed_cost"] is not None
            or row["effective_cost"] is not None
            or row["list_cost"] is not None
            for row in usage_rows
        ),
    }


def cloudflare_billing_usage(
    *,
    account_id: str,
    token: str,
    observed_at: datetime,
) -> dict[str, Any]:
    start = CUTOVER_AT.date()
    end = observed_at.date()
    rows: list[Mapping[str, Any]] = []
    windows: list[dict[str, str]] = []
    while start <= end:
        window_end = min(start + timedelta(days=30), end)
        window = {"from": start.isoformat(), "to": window_end.isoformat()}
        windows.append(window)
        request = Request(
            (
                "https://api.cloudflare.com/client/v4/accounts/"
                f"{account_id}/billable/usage?{urlencode(window)}"
            ),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except HTTPError as error:
            return {
                "status": (
                    "authentication_scope_missing"
                    if error.code in {401, 403}
                    else "api_unavailable"
                ),
                "api_status": error.code,
                "windows": windows,
                "mutable_actions_performed": False,
            }
        except (URLError, TimeoutError):
            return {
                "status": "api_unavailable",
                "api_status": 0,
                "detail": "network_error",
                "windows": windows,
                "mutable_actions_performed": False,
            }
        if not isinstance(payload, Mapping) or payload.get("success") is not True:
            return {
                "status": "api_unavailable",
                "api_status": 200,
                "detail": "unsuccessful_response",
                "windows": windows,
                "mutable_actions_performed": False,
            }
        rows.extend(
            row
            for row in payload.get("result") or []
            if isinstance(row, Mapping)
        )
        start = window_end + timedelta(days=1)
    report = summarize_cloudflare_billing_rows(rows)
    report.update(
        {
            "status": "usage_observed" if rows else "no_usage_rows_yet",
            "api_status": 200,
            "windows": windows,
            "mutable_actions_performed": False,
            "cost_note": (
                "Cloudflare billing usage API may omit cost fields while "
                "billing integration is incomplete."
            ),
        }
    )
    return report


def google_adc_access_token() -> tuple[str | None, str | None]:
    try:
        result = subprocess.run(
            [
                "gcloud",
                "auth",
                "application-default",
                "print-access-token",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None, "gcloud_adc_unavailable"
    token = result.stdout.strip()
    if result.returncode != 0 or not token:
        return None, "gcloud_adc_unavailable"
    return token, None


def google_json(
    url: str,
    *,
    token: str,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
) -> tuple[int, dict[str, Any], str | None]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
            if not isinstance(result, dict):
                return response.status, {}, "non_object_response"
            return response.status, result, None
    except HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8", "replace"))
            api_error = body.get("error") if isinstance(body, dict) else {}
            status = (
                api_error.get("status")
                if isinstance(api_error, Mapping)
                else None
            )
        except (json.JSONDecodeError, UnicodeDecodeError):
            status = None
        detail = str(status or f"http_{error.code}").lower()
        return error.code, {}, detail
    except (URLError, TimeoutError):
        return 0, {}, "network_error"


def summarize_ga4_report(payload: Mapping[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for source in payload.get("rows") or []:
        if not isinstance(source, Mapping):
            continue
        dimensions = source.get("dimensionValues") or []
        metrics = source.get("metricValues") or []
        host = str(dimensions[0].get("value") or "") if dimensions else ""
        if not host:
            continue
        rows.append(
            {
                "host_name": host,
                "screen_page_views": int(metrics[0].get("value") or 0)
                if len(metrics) >= 1
                else 0,
                "active_users": int(metrics[1].get("value") or 0)
                if len(metrics) >= 2
                else 0,
            }
        )
    production_rows = [
        row for row in rows if row["host_name"] in PRODUCTION_HOSTS
    ]
    return {
        "rows": rows,
        "production_rows": production_rows,
        "production_hosts_observed": sorted(
            row["host_name"] for row in production_rows
        ),
    }


def summarize_search_console_sites(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    sites = [
        {
            "site_url": str(row.get("siteUrl") or ""),
            "permission_level": str(row.get("permissionLevel") or ""),
        }
        for row in payload.get("siteEntry") or []
        if isinstance(row, Mapping) and row.get("siteUrl")
    ]
    target = next(
        (row for row in sites if row["site_url"] == SEARCH_CONSOLE_SITE),
        None,
    )
    return {"accessible_site_count": len(sites), "target_site": target}


def collect_google_observations(observed_at: datetime) -> dict[str, Any]:
    token, auth_error = google_adc_access_token()
    if token is None:
        unavailable = {
            "status": "authentication_unavailable",
            "detail": auth_error,
            "mutable_actions_performed": False,
        }
        return {"ga4": unavailable, "search_console": unavailable.copy()}

    ga4_payload = {
        "dateRanges": [
            {
                "startDate": CUTOVER_AT.date().isoformat(),
                "endDate": observed_at.date().isoformat(),
            }
        ],
        "dimensions": [{"name": "hostName"}],
        "metrics": [
            {"name": "screenPageViews"},
            {"name": "activeUsers"},
        ],
        "limit": "100",
    }
    ga4_status, ga4_result, ga4_error = google_json(
        (
            "https://analyticsdata.googleapis.com/v1beta/properties/"
            f"{GA4_PROPERTY_ID}:runReport"
        ),
        token=token,
        method="POST",
        payload=ga4_payload,
    )
    if ga4_status == 200:
        ga4 = summarize_ga4_report(ga4_result)
        ga4.update(
            {
                "status": (
                    "production_host_data_observed"
                    if ga4["production_rows"]
                    else "pending_standard_processing_or_no_traffic"
                ),
                "api_status": ga4_status,
                "property_id": GA4_PROPERTY_ID,
                "date_range": ga4_payload["dateRanges"][0],
                "mutable_actions_performed": False,
            }
        )
    else:
        ga4 = {
            "status": "api_unavailable",
            "api_status": ga4_status,
            "detail": ga4_error,
            "property_id": GA4_PROPERTY_ID,
            "mutable_actions_performed": False,
        }

    search_status, search_result, search_error = google_json(
        "https://www.googleapis.com/webmasters/v3/sites",
        token=token,
    )
    if search_status == 200:
        search_console = summarize_search_console_sites(search_result)
        search_console.update(
            {
                "status": (
                    "target_site_accessible"
                    if search_console["target_site"]
                    else "target_site_not_accessible"
                ),
                "api_status": search_status,
                "mutable_actions_performed": False,
            }
        )
    else:
        search_console = {
            "status": (
                "authentication_scope_missing"
                if search_status == 403
                else "api_unavailable"
            ),
            "api_status": search_status,
            "detail": search_error,
            "target_site": None,
            "mutable_actions_performed": False,
        }
    return {"ga4": ga4, "search_console": search_console}


def summarize_worker_metrics(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    totals = {"requests": 0, "errors": 0, "subrequests": 0}
    statuses: dict[str, int] = {}
    for row in rows:
        sums = row.get("sum") if isinstance(row.get("sum"), Mapping) else {}
        for key in totals:
            totals[key] += int(sums.get(key) or 0)
        dimensions = (
            row.get("dimensions")
            if isinstance(row.get("dimensions"), Mapping)
            else {}
        )
        status = str(dimensions.get("status") or "unknown")
        statuses[status] = statuses.get(status, 0) + int(sums.get("requests") or 0)
    error_rate = (
        totals["errors"] / totals["requests"] * 100
        if totals["requests"]
        else 0.0
    )
    return {
        **totals,
        "error_rate_percent": round(error_rate, 6),
        "statuses": dict(sorted(statuses.items())),
    }


def worker_metrics(
    *,
    account_id: str,
    token: str,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    query = """
query Monitor($accountTag: string, $start: Time, $end: Time, $scriptName: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: $scriptName
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        sum { requests errors subrequests }
        dimensions { status }
      }
    }
  }
}
"""
    payload = {
        "query": query,
        "variables": {
            "accountTag": account_id,
            "start": iso_z(start),
            "end": iso_z(end),
            "scriptName": WORKER_SERVICE,
        },
    }
    response = cloudflare_json(
        "/graphql", token=token, method="POST", payload=payload
    )
    if response.get("errors"):
        raise MonitorError("Cloudflare GraphQL returned query errors")
    accounts = (
        ((response.get("data") or {}).get("viewer") or {}).get("accounts")
        or []
    )
    if len(accounts) != 1:
        raise MonitorError(
            "Cloudflare GraphQL did not return exactly one account"
        )
    rows = accounts[0].get("workersInvocationsAdaptive") or []
    return summarize_worker_metrics(rows)


def run_public_readback(base_url: str, *, preview: bool) -> dict[str, Any]:
    command = [
        sys.executable,
        str(REPO_ROOT / "scripts/migration/verify_public_site.py"),
        "--base-url",
        base_url,
    ]
    if not preview:
        command.append("--no-expect-preview-noindex")
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise MonitorError(
            f"Public readback returned invalid JSON for {base_url}"
        ) from error
    return {
        "verified": report.get("verified") is True and result.returncode == 0,
        "checks": len(report.get("checks") or []),
        "failed": int(report.get("failed") or 0),
        "failures": [
            {
                "name": row.get("name"),
                "status": row.get("status"),
                "detail": row.get("detail"),
            }
            for row in report.get("checks") or []
            if row.get("ok") is not True
        ],
    }


def classify_404_rows(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    internal_rows: list[dict[str, Any]] = []
    external_rows: list[dict[str, Any]] = []
    legacy_client_rows: list[dict[str, Any]] = []
    monitor_hits = 0
    total_hits = 0
    for source in rows:
        row = dict(source)
        hits = int(row.get("hits") or 0)
        total_hits += hits
        path = str(row.get("path") or "")
        referrer = str(row.get("referrer") or "")
        if path == "/definitely-missing-yohaku-monitor":
            monitor_hits += hits
        if path.startswith(LEGACY_CLIENT_PATH_PREFIXES):
            legacy_client_rows.append(row)
        elif any(f"//{host}/" in referrer for host in PRODUCTION_HOSTS):
            internal_rows.append(row)
        elif referrer:
            external_rows.append(row)
    return {
        "rows": len(rows),
        "hits": total_hits,
        "monitor_hits": monitor_hits,
        "internal_referrer_rows": internal_rows,
        "external_referrer_rows": external_rows,
        "legacy_client_rows": legacy_client_rows,
    }


def query_404_log(*, env: Mapping[str, str]) -> dict[str, Any]:
    start_sql = CUTOVER_AT.astimezone(timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    sql = (
        "SELECT path,hits,created_at,last_seen_at,COALESCE(referrer,'') AS referrer,"
        "COALESCE(user_agent,'') AS user_agent "
        "FROM _emdash_404_log "
        f"WHERE datetime(COALESCE(last_seen_at,created_at)) >= datetime('{start_sql}') "
        "ORDER BY datetime(COALESCE(last_seen_at,created_at)) DESC LIMIT 500;"
    )
    result = subprocess.run(
        [
            str(WRANGLER_BIN),
            "d1",
            "execute",
            DATABASE_NAME,
            "--remote",
            "--config",
            str(WEB_ROOT / "wrangler.jsonc"),
            "--json",
            "--command",
            sql,
        ],
        cwd=REPO_ROOT,
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise MonitorError("D1 404 readback failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise MonitorError("D1 404 readback returned invalid JSON") from error
    if not payload or payload[0].get("success") is not True:
        raise MonitorError("D1 404 readback was unsuccessful")
    return classify_404_rows(payload[0].get("results") or [])


def collect(checkpoint: str, observed_at: datetime) -> dict[str, Any]:
    credential = load_credential()
    env = child_environment(credential)
    preflight(credential, env)

    zone_response = cloudflare_json(
        f"/zones/{ZONE_ID}", token=credential["api_token"]
    )
    zone = zone_response.get("result") or {}
    domain_response = cloudflare_json(
        f"/accounts/{credential['account_id']}/workers/domains",
        token=credential["api_token"],
    )
    expected_domains = {
        row.get("hostname"): {
            "service": row.get("service"),
            "environment": row.get("environment"),
        }
        for row in domain_response.get("result") or []
        if row.get("hostname") in PRODUCTION_HOSTS
    }

    readback = {
        "blog": run_public_readback(
            "https://blog.kanouk.com", preview=False
        ),
        "photos": run_public_readback(
            "https://photos.kanouk.com", preview=False
        ),
        "staging": run_public_readback(STAGING_URL, preview=True),
    }
    metrics = worker_metrics(
        account_id=credential["account_id"],
        token=credential["api_token"],
        start=CUTOVER_AT,
        end=observed_at,
    )
    not_found = query_404_log(env=env)
    google_observations = collect_google_observations(observed_at)
    billing_usage = cloudflare_billing_usage(
        account_id=credential["account_id"],
        token=credential["api_token"],
        observed_at=observed_at,
    )
    elapsed_seconds = round(
        (
            observed_at.astimezone(timezone.utc)
            - CUTOVER_AT.astimezone(timezone.utc)
        ).total_seconds()
    )
    infrastructure_ok = (
        zone.get("name") == ZONE_NAME
        and zone.get("status") == "active"
        and set(expected_domains) == set(PRODUCTION_HOSTS)
        and all(
            row.get("service") == WORKER_SERVICE
            for row in expected_domains.values()
        )
    )
    public_ok = all(row["verified"] for row in readback.values())
    worker_ok = metrics["errors"] == 0
    navigation_ok = not not_found["internal_referrer_rows"]
    return {
        "report_version": 2,
        "checkpoint": checkpoint,
        "checkpoint_due": checkpoint_due(checkpoint, observed_at),
        "observed_at": observed_at.isoformat(),
        "cutover_at": CUTOVER_AT.isoformat(),
        "elapsed_seconds": elapsed_seconds,
        "account_email": "kanouk@gmail.com",
        "zone": {
            "name": zone.get("name"),
            "status": zone.get("status"),
            "name_servers": zone.get("name_servers") or [],
        },
        "custom_domains": expected_domains,
        "public_readback": readback,
        "worker_invocations": metrics,
        "not_found_log": not_found,
        "external_services": {
            **google_observations,
            "cloudflare_billing_usage": billing_usage,
            "cloudflare_zone_http_analytics": (
                "not_available_to_minimum_scope_token"
            ),
        },
        "gates": {
            "infrastructure": infrastructure_ok,
            "public_readback": public_ok,
            "worker_errors": worker_ok,
            "internal_404_referrers": navigation_ok,
        },
        "verified": (
            infrastructure_ok and public_ok and worker_ok and navigation_ok
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        choices=sorted(CHECKPOINT_SECONDS),
        default="interim",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--allow-early",
        action="store_true",
        help=(
            "Write an early observation without satisfying the checkpoint "
            "time gate."
        ),
    )
    args = parser.parse_args()
    observed_at = datetime.now().astimezone()
    report = collect(args.checkpoint, observed_at)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
    if not report["checkpoint_due"] and not args.allow_early:
        raise SystemExit(2)
    if not report["verified"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
