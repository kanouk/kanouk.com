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
    "audit_smugmug.py",
    "build_smugmug_pilot_manifest.py",
    "download_smugmug_pilot_asset.py",
    "select_smugmug_pilot.py",
}


class SmugMugCredentialError(RuntimeError):
    pass


def load_api_key(path: Path = DEFAULT_CREDENTIAL_FILE) -> str:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise SmugMugCredentialError(f"Credential file does not exist: {path}") from exc
    match = re.search(r"^API Key:\s*`([^`]+)`$", text, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise SmugMugCredentialError("Credential file has no configured API Key")
    return match.group(1).strip()


def child_environment(
    api_key: str, base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    env["SMUGMUG_API_KEY"] = api_key
    return env


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
        api_key = load_api_key()
        return subprocess.run(
            command,
            cwd=SCRIPT_ROOT.parents[1],
            env=child_environment(api_key),
            check=False,
        ).returncode
    except SmugMugCredentialError as exc:
        print(f"SmugMug read-only runner blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
