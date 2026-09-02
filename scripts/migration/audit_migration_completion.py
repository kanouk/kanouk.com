#!/usr/bin/env python3
"""Build a fail-closed migration completion audit from local ledgers.

The default report is informational and always exits successfully. Pass
``--require-complete`` when the command is used as a cutover gate.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from report_smugmug_migration import build_report as build_smugmug_report  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"required audit input not found: {path}")
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"audit input must be a JSON object: {path}")
    return data


def wordpress_summary(
    conversion_path: Path, media_path: Path, import_path: Path
) -> dict[str, Any]:
    conversion = load_json(conversion_path)
    media = load_json(media_path)
    content_import = load_json(import_path)

    conversion_totals = conversion.get("totals") or {}
    media_counts = media.get("counts") or {}
    import_counts = content_import.get("counts") or {}
    import_results = import_counts.get("results") or {}

    expected_content = int(conversion_totals.get("posts") or 0) + int(
        conversion_totals.get("pages") or 0
    )
    selected = int(import_counts.get("selected") or 0)
    failed = int(import_counts.get("failed") or 0)
    skipped_verified = int(import_results.get("skipped_verified") or 0)
    media_total = int(media.get("total_available") or 0)
    media_verified = int(media_counts.get("verified") or 0)

    converted_blocks = int(conversion_totals.get("convertedBlocks") or 0)
    conversion_complete = (
        expected_content == 1854
        # The exact block count can legitimately increase when a raw legacy
        # construct is replaced by several semantic Yohaku blocks. Completion
        # is therefore tied to full source coverage and zero htmlBlock
        # fallbacks, not to one historical generated count.
        and converted_blocks >= expected_content
        and int(conversion_totals.get("htmlBlocks") or 0) == 0
    )
    media_complete = media_total == 2028 and media_verified == media_total
    content_complete = (
        selected == expected_content
        and skipped_verified == selected
        and failed == 0
    )

    return {
        "conversion": {
            "content": expected_content,
            "blocks": converted_blocks,
            "html_blocks": int(conversion_totals.get("htmlBlocks") or 0),
            "complete": conversion_complete,
        },
        "media": {
            "total": media_total,
            "verified": media_verified,
            "complete": media_complete,
        },
        "content_import": {
            "selected": selected,
            "skipped_verified": skipped_verified,
            "failed": failed,
            "complete": content_complete,
        },
        "complete": conversion_complete and media_complete and content_complete,
    }


def backup_summary(
    manifest_path: Path | None, verification_path: Path | None
) -> dict[str, Any]:
    if manifest_path is None:
        return {
            "manifest_supplied": False,
            "verification_supplied": False,
            "verified": False,
        }
    manifest = load_json(manifest_path)
    d1 = manifest.get("d1") or {}
    media_count = int(manifest.get("media_count") or 0)
    media_total_bytes = int(manifest.get("media_total_bytes") or 0)
    r2_object_count = int(manifest.get("r2_object_count") or media_count)
    r2_total_bytes = int(manifest.get("r2_total_bytes") or media_total_bytes)
    manifest_complete = (
        bool(d1.get("sha256"))
        and media_count > 0
        and media_total_bytes > 0
        and r2_object_count >= media_count
        and r2_total_bytes >= media_total_bytes
    )
    verification = load_json(verification_path) if verification_path else None
    restore_verified = bool(
        verification
        and verification.get("verified") is True
        and int(verification.get("media_count") or 0) == media_count
        and int(verification.get("media_total_bytes") or 0) == media_total_bytes
        and int(verification.get("r2_object_count") or media_count)
        == r2_object_count
        and int(verification.get("r2_total_bytes") or media_total_bytes)
        == r2_total_bytes
        and verification.get("d1_integrity") == "ok"
        and int(verification.get("d1_foreign_key_violations") or 0) == 0
    )
    return {
        "manifest_supplied": True,
        "verification_supplied": verification is not None,
        "source": manifest.get("source"),
        "database": manifest.get("database"),
        "d1_sha256_present": bool(d1.get("sha256")),
        "media_count": media_count,
        "media_total_bytes": media_total_bytes,
        "r2_object_count": r2_object_count,
        "r2_total_bytes": r2_total_bytes,
        "untracked_r2_count": int(manifest.get("untracked_r2_count") or 0),
        "untracked_r2_total_bytes": int(
            manifest.get("untracked_r2_total_bytes") or 0
        ),
        "manifest_complete": manifest_complete,
        "verified": manifest_complete and restore_verified,
    }


def public_audit_summary(report_path: Path | None) -> dict[str, Any]:
    if report_path is None:
        return {"report_supplied": False, "verified": False}
    report = load_json(report_path)
    forbidden_counts = report.get("forbidden_counts") or {}
    allowed_smugmug_ids = report.get("allowed_smugmug_ids") or []
    verified = bool(
        report.get("verified") is True
        and int(report.get("failure_count") or 0) == 0
        and int(report.get("public_pages") or 0) > 0
        and int(report.get("internal_links") or 0) > 0
        and all(int(value or 0) == 0 for value in forbidden_counts.values())
        and not allowed_smugmug_ids
    )
    return {
        "report_supplied": True,
        "base_url": report.get("base_url"),
        "public_pages": int(report.get("public_pages") or 0),
        "internal_links": int(report.get("internal_links") or 0),
        "forbidden_counts": forbidden_counts,
        "allowed_smugmug_ids": allowed_smugmug_ids,
        "failure_count": int(report.get("failure_count") or 0),
        "verified": verified,
    }


def build_audit(
    *,
    conversion_path: Path,
    wordpress_media_path: Path,
    wordpress_import_path: Path,
    smugmug_catalog_path: Path,
    backup_manifest_path: Path | None = None,
    backup_verification_path: Path | None = None,
    public_audit_path: Path | None = None,
    dns_change_authorized: bool = False,
) -> dict[str, Any]:
    wordpress = wordpress_summary(
        conversion_path, wordpress_media_path, wordpress_import_path
    )
    smugmug = build_smugmug_report(smugmug_catalog_path)
    backup = backup_summary(backup_manifest_path, backup_verification_path)
    public_audit = public_audit_summary(public_audit_path)

    pending_owner_auth = int(
        (smugmug.get("statuses") or {}).get("pending_owner_auth") or 0
    )
    pending_albums = [
        {
            "slug": row.get("slug"),
            "source_album_key": row.get("source_album_key"),
            "assets": int((row.get("statuses") or {}).get("pending_owner_auth") or 0),
        }
        for row in smugmug.get("album_results") or []
        if int((row.get("statuses") or {}).get("pending_owner_auth") or 0) > 0
    ]

    blockers: list[dict[str, Any]] = []
    if pending_owner_auth:
        blockers.append(
            {
                "code": "smugmug_owner_auth_required",
                "assets": pending_owner_auth,
                "albums": pending_albums,
                "resolution": "Authorize SmugMug Full/Read OAuth, then resume only these albums.",
            }
        )
    if not wordpress["complete"]:
        blockers.append(
            {
                "code": "wordpress_ledger_incomplete",
                "resolution": "Repair the WordPress conversion/media/import ledger before cutover.",
            }
        )

    data_complete = wordpress["complete"] and bool(smugmug.get("complete"))
    completion_verified = data_complete and backup["verified"] and public_audit["verified"]
    return {
        "report_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "wordpress": wordpress,
        "smugmug": {
            "albums": int(smugmug.get("albums") or 0),
            "assets": int(smugmug.get("assets") or 0),
            "statuses": smugmug.get("statuses") or {},
            "duplicate_media_ids": smugmug.get("duplicate_media_ids") or [],
            "manifest_mismatches": smugmug.get("manifest_mismatches") or [],
            "pending_albums": pending_albums,
            "complete": bool(smugmug.get("complete")),
        },
        "backup": backup,
        "public_audit": public_audit,
        "gates": {
            "data_migration_complete": data_complete,
            "backup_restore_verified": backup["verified"],
            "final_public_audit_verified": public_audit["verified"],
            "dns_change_authorized": dns_change_authorized,
            "cancellation_in_scope": False,
            "cutover_ready": completion_verified and not blockers,
        },
        "blockers": blockers,
        "complete": completion_verified and not blockers,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--conversion-audit",
        default=REPO_ROOT / "migration/wordpress/conversion-audit.json",
        type=Path,
    )
    parser.add_argument(
        "--wordpress-media-ledger",
        default=REPO_ROOT / "migration/wordpress/runtime/media-ledger.json",
        type=Path,
    )
    parser.add_argument(
        "--wordpress-import-ledger",
        default=REPO_ROOT / "migration/wordpress/runtime/import-ledger.json",
        type=Path,
    )
    parser.add_argument(
        "--smugmug-catalog",
        default=REPO_ROOT / "migration/smugmug/catalog.json",
        type=Path,
    )
    parser.add_argument("--backup-manifest", type=Path)
    parser.add_argument("--backup-verification", type=Path)
    parser.add_argument("--public-audit", type=Path)
    parser.add_argument(
        "--dns-change-authorized",
        action="store_true",
        help="Record that the owner has explicitly authorized the DNS cutover.",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()

    report = build_audit(
        conversion_path=args.conversion_audit.resolve(),
        wordpress_media_path=args.wordpress_media_ledger.resolve(),
        wordpress_import_path=args.wordpress_import_ledger.resolve(),
        smugmug_catalog_path=args.smugmug_catalog.resolve(),
        backup_manifest_path=(
            args.backup_manifest.resolve() if args.backup_manifest else None
        ),
        backup_verification_path=(
            args.backup_verification.resolve() if args.backup_verification else None
        ),
        public_audit_path=(args.public_audit.resolve() if args.public_audit else None),
        dns_change_authorized=args.dns_change_authorized,
    )
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(output)
    else:
        print(output, end="")
    if args.require_complete and not report["complete"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
