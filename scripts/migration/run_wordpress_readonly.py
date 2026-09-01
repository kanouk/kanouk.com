#!/usr/bin/env python3
"""Run allowlisted read-only WordPress scripts with kanolog credentials."""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping, Sequence
from urllib.parse import urlparse


DEFAULT_CREDENTIAL_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/WordPress-kanolog.md"
SCRIPT_ROOT = Path(__file__).resolve().parent
ALLOWED = {
    "audit_wordpress.py": "rest",
    "fetch_wordpress_rest_delta.py": None,
}


class WordPressCredentialError(RuntimeError):
    pass


def field(text: str, label: str) -> str:
    match = re.search(
        rf"^- {re.escape(label)}:\s*(?:`([^`]+)`|([^\r\n]+))$",
        text,
        re.MULTILINE,
    )
    value = (match.group(1) or match.group(2)).strip() if match else ""
    if not value:
        raise WordPressCredentialError(f"Credential file is missing {label}")
    return value


def load_credential(path: Path = DEFAULT_CREDENTIAL_FILE) -> dict[str, str]:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise WordPressCredentialError(f"Credential file does not exist: {path}") from exc
    credential = {
        "site": field(text, "Site URL").rstrip("/"),
        "username": field(text, "Username"),
        "password": field(text, "Application Password"),
    }
    if (urlparse(credential["site"]).hostname or "").lower() != "kanolog.net":
        raise WordPressCredentialError("Source host must be kanolog.net")
    return credential


def child_environment(
    credential: Mapping[str, str], base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    env["WP_AUDIT_USER"] = credential["username"]
    env["WP_AUDIT_PASSWORD"] = credential["password"]
    return env


def normalized_command(args: Sequence[str], credential: Mapping[str, str]) -> list[str]:
    values = list(args)
    if not values or values[0] not in ALLOWED:
        raise WordPressCredentialError(
            "Specify an allowlisted script: " + ", ".join(sorted(ALLOWED))
        )
    script_name = values.pop(0)
    required_subcommand = ALLOWED[script_name]
    if required_subcommand:
        if not values or values.pop(0) != required_subcommand:
            raise WordPressCredentialError(
                f"{script_name} is restricted to {required_subcommand}"
            )
        values.insert(0, required_subcommand)
    if "--site" in values:
        raise WordPressCredentialError("Source site override is blocked")
    if script_name == "audit_wordpress.py":
        if "--username-env" in values or "--password-env" in values:
            raise WordPressCredentialError("Credential environment override is blocked")
        values.extend(
            [
                "--username-env",
                "WP_AUDIT_USER",
                "--password-env",
                "WP_AUDIT_PASSWORD",
            ]
        )
    script = (SCRIPT_ROOT / script_name).resolve()
    if script.parent != SCRIPT_ROOT or not script.is_file():
        raise WordPressCredentialError("WordPress script path is invalid")
    return [sys.executable, str(script), *values, "--site", credential["site"]]


def main(argv: Sequence[str] | None = None) -> int:
    try:
        credential = load_credential()
        command = normalized_command(list(sys.argv[1:] if argv is None else argv), credential)
        return subprocess.run(
            command,
            cwd=SCRIPT_ROOT.parents[1],
            env=child_environment(credential),
            check=False,
        ).returncode
    except WordPressCredentialError as exc:
        print(f"WordPress read-only runner blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
