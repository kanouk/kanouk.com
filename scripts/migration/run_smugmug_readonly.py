#!/usr/bin/env python3
"""Run an allowlisted SmugMug read-only script with the API key kept private."""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping, Sequence


DEFAULT_CREDENTIAL_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/SmugMug.md"
SCRIPT_ROOT = Path(__file__).resolve().parent
ALLOWED_SCRIPTS = {
    "apply_smugmug_album_covers.py",
    "audit_smugmug.py",
    "backfill_smugmug_metadata.py",
    "build_smugmug_catalog.py",
    "build_smugmug_pilot_manifest.py",
    "diagnose_smugmug_asset.py",
    "download_smugmug_pilot_asset.py",
    "migrate_smugmug_album.py",
    "migrate_smugmug_catalog.py",
    "resume_smugmug_owner_migration.py",
    "select_smugmug_pilot.py",
}


class SmugMugCredentialError(RuntimeError):
    pass


def load_credentials(path: Path = DEFAULT_CREDENTIAL_FILE) -> dict[str, str]:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise SmugMugCredentialError(f"Credential file does not exist: {path}") from exc
    values = {
        label: match.group(1).strip()
        for label in ("API Key", "API Secret", "Access Token", "Access Token Secret")
        if (
            match := re.search(
                rf"^{re.escape(label)}:\s*`([^`]+)`$", text, re.MULTILINE
            )
        )
        and match.group(1).strip()
    }
    if not values.get("API Key"):
        raise SmugMugCredentialError("Credential file has no configured API Key")
    owner_labels = ("API Secret", "Access Token", "Access Token Secret")
    owner_values = [values.get(label) for label in owner_labels]
    if any(owner_values[1:]) and not all(owner_values):
        raise SmugMugCredentialError("Credential file has incomplete owner credentials")
    return values


def load_api_key(path: Path = DEFAULT_CREDENTIAL_FILE) -> str:
    return load_credentials(path)["API Key"]


def child_environment(
    credentials: str | Mapping[str, str], base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    values = {"API Key": credentials} if isinstance(credentials, str) else credentials
    env["SMUGMUG_API_KEY"] = values["API Key"]
    labels = {
        "API Secret": "SMUGMUG_API_SECRET",
        "Access Token": "SMUGMUG_ACCESS_TOKEN",
        "Access Token Secret": "SMUGMUG_ACCESS_TOKEN_SECRET",
    }
    owner_ready = all(values.get(label) for label in labels)
    for label, environment_name in labels.items():
        if owner_ready:
            env[environment_name] = values[label]
        else:
            env.pop(environment_name, None)
    return env


def requires_smugmug_credentials(args: Sequence[str]) -> bool:
    result = list(args)
    if result[:1] == ["--"]:
        result = result[1:]
    if not result:
        return True
    if result[0] == "apply_smugmug_album_covers.py":
        return "--refresh-from-smugmug" in result
    return True


def normalized_command(args: Sequence[str]) -> list[str]:
    result = list(args)
    if result[:1] == ["--"]:
        result = result[1:]
    if not result or result[0] not in ALLOWED_SCRIPTS:
        allowed = ", ".join(sorted(ALLOWED_SCRIPTS))
        raise SmugMugCredentialError(f"Specify an allowlisted script: {allowed}")
    script = (SCRIPT_ROOT / result[0]).resolve()
    if script.parent != SCRIPT_ROOT or not script.is_file():
        raise SmugMugCredentialError("SmugMug script path is invalid")
    return [sys.executable, str(script), *result[1:]]


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        command = normalized_command(args)
        env = dict(os.environ)
        if requires_smugmug_credentials(args):
            env = child_environment(load_credentials(), env)
        return subprocess.run(
            command,
            cwd=SCRIPT_ROOT.parents[1],
            env=env,
            check=False,
        ).returncode
    except SmugMugCredentialError as exc:
        print(f"SmugMug read-only runner blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
