#!/usr/bin/env python3
"""Verify an R2 download and record the successful pilot roundtrip in a manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any, BinaryIO

from audit_smugmug import now_iso


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def record(
    manifest: dict[str, Any],
    receipt: dict[str, Any],
    *,
    r2_object_key: str,
    r2_download_sha256: str,
    probe_deleted_after_verification: bool = False,
) -> dict[str, Any]:
    expected = receipt.get("sha256")
    if not expected or expected != r2_download_sha256:
        raise ValueError("R2 download SHA-256 does not match the source download")
    asset_id = receipt.get("asset_id")
    try:
        asset = next(item for item in manifest["assets"] if item["id"] == asset_id)
    except StopIteration as exc:
        raise ValueError(f"Receipt asset is absent from manifest: {asset_id}") from exc
    if receipt.get("md5") != asset["source"].get("archived_md5"):
        raise ValueError("Receipt MD5 does not match the manifest source MD5")
    if not probe_deleted_after_verification:
        asset["destination"]["r2_object_key"] = r2_object_key
    asset["verification"] = {
        "source_md5_verified": True,
        "sha256": expected,
        "r2_roundtrip_verified": True,
        "verified_at": now_iso(),
    }
    if receipt.get("source_exif"):
        asset["verification"]["source_exif"] = receipt["source_exif"]
    if probe_deleted_after_verification:
        asset["verification"]["r2_probe"] = {
            "object_key": r2_object_key,
            "deleted_after_verification": True,
        }
    return asset


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--manifest", required=True)
    result.add_argument("--receipt", required=True)
    result.add_argument("--r2-object-key", required=True)
    result.add_argument("--r2-download", required=True)
    result.add_argument("--probe-deleted-after-verification", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())
    receipt = json.loads(Path(args.receipt).read_text())
    r2_sha256 = sha256_file(Path(args.r2_download))
    asset = record(
        manifest,
        receipt,
        r2_object_key=args.r2_object_key,
        r2_download_sha256=r2_sha256,
        probe_deleted_after_verification=args.probe_deleted_after_verification,
    )
    write_json_atomic(manifest_path, manifest)
    print(
        json.dumps(
            {
                "asset_id": asset["id"],
                "r2_object_key": args.r2_object_key,
                "sha256": asset["verification"]["sha256"],
                "r2_roundtrip_verified": True,
                "probe_deleted_after_verification": args.probe_deleted_after_verification,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
