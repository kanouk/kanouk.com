#!/usr/bin/env python3
"""Run the local EmDash site with its key loaded from the Private Vault."""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping, Sequence


DEFAULT_SECRET_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/Cloudflare-kanouk.md"
PLACEHOLDER_PREFIX = "REPLACE_WITH_"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class SecretError(RuntimeError):
    pass


def load_emdash_key(path: Path = DEFAULT_SECRET_FILE) -> str:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise SecretError(f"Secret file does not exist: {path}") from exc
    match = re.search(
        r"^- EmDash Encryption Key: `([^`]+)`$", text, re.MULTILINE
    )
    if not match:
        raise SecretError("Secret file is missing the EmDash Encryption Key field")
    value = match.group(1).strip()
    if not value or value.startswith(PLACEHOLDER_PREFIX):
        raise SecretError("Secret file has no configured EmDash Encryption Key")
    if not re.fullmatch(r"emdash_enc_v1_[A-Za-z0-9_-]{43}", value):
        raise SecretError("EmDash Encryption Key has an unexpected format")
    return value


def child_environment(
    key: str, base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    env["EMDASH_ENCRYPTION_KEY"] = key
    return env


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args:
        print("run_emdash_local.py does not accept extra commands", file=sys.stderr)
        return 2
    try:
        key = load_emdash_key()
        return subprocess.run(
            ["bun", "run", "dev:raw"],
            cwd=REPOSITORY_ROOT / "apps/web",
            env=child_environment(key),
            check=False,
        ).returncode
    except SecretError as exc:
        print(f"EmDash local runner blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
