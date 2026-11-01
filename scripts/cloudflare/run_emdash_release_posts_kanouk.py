#!/usr/bin/env python3
"""Manage release posts with a dedicated, scoped token and the existing guards."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

import provision_emdash_import_token_kanouk as provisioning
import run_emdash_kanouk as emdash
import run_wrangler_kanouk as cloudflare


TOKEN_NAME = "kanouk.com EmDash release posts"
TOKEN_FILE = emdash.DEFAULT_CREDENTIAL_FILE.with_name("EmDash-kanouk-release-posts.md")
SCOPES = ["content:read", "content:write", "media:read", "media:write", "schema:read"]


def normalized_args(args):
    args = emdash.normalized_args(args)
    if any(arg in {"--token", "--header", "-H"} or arg.startswith(("--url=", "--token=", "--header=", "-u", "-H")) for arg in args):
        raise emdash.EmDashGuardError("Origin and authentication overrides are blocked")
    content_actions = {"list", "get", "create", "update", "publish", "unpublish"}
    media_actions = {"list", "get", "upload"}
    if args[0] == "content" and len(args) >= 3 and args[1] in content_actions and args[2] == "posts":
        return args
    if args[0] == "media" and len(args) >= 2 and args[1] in media_actions:
        return args
    if args == ["schema", "get", "posts", "--json"]:
        return args
    raise emdash.EmDashGuardError("Only post authoring, media upload/read and post schema reads are allowed")


def provision():
    credential = cloudflare.load_credential()
    env = cloudflare.child_environment(credential)
    cloudflare.preflight(credential, env)
    provisioning._verify_owner(env)
    previous_id = None
    if TOKEN_FILE.exists():
        match = re.search(r"^- Token ID: `([^`]+)`$", TOKEN_FILE.read_text(), re.MULTILINE)
        if not match or not re.fullmatch(r"erp_[a-f0-9]{32}", match.group(1)):
            raise emdash.EmDashGuardError("Refusing to replace an unknown credential file")
        previous_id = match.group(1)
    raw, digest, prefix = provisioning._generate_token()
    token_id = "erp_" + uuid.uuid4().hex
    expiry = (datetime.now(timezone.utc) + timedelta(days=90)).isoformat(timespec="milliseconds")
    literal = provisioning._sql_literal
    sql = "INSERT INTO _emdash_api_tokens (id,name,token_hash,prefix,user_id,scopes,expires_at) VALUES ("
    sql += ",".join(literal(v) for v in [token_id, TOKEN_NAME, digest, prefix, provisioning.EXPECTED_USER_ID, json.dumps(SCOPES), expiry]) + ")"
    provisioning._run_sql(sql, env)
    result = provisioning._rows(provisioning._run_sql(
        "SELECT user_id,scopes FROM _emdash_api_tokens WHERE id=" + literal(token_id), env
    ))
    if len(result) != 1 or result[0]["user_id"] != provisioning.EXPECTED_USER_ID or json.loads(result[0]["scopes"]) != SCOPES:
        raise emdash.EmDashGuardError("Dedicated token readback did not match")
    candidate = {"email": emdash.EXPECTED_EMAIL, "url": emdash.EXPECTED_URL, "token": raw}
    try:
        emdash.preflight(emdash.child_environment(candidate))
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", dir=TOKEN_FILE.parent, delete=False) as output:
            os.chmod(output.name, 0o600)
            output.write(
                "# EmDash release-post authoring\n\n"
                f"- Admin Email: `{emdash.EXPECTED_EMAIL}`\n"
                f"- URL: `{emdash.EXPECTED_URL}`\n"
                f"- Token Name: `{TOKEN_NAME}`\n"
                f"- Token ID: `{token_id}`\n"
                f"- Scopes: `{' '.join(SCOPES)}`\n"
                f"- Expires: `{expiry}`\n"
                f"- Token: `{raw}`\n"
            )
        os.replace(output.name, TOKEN_FILE)
    except Exception:
        provisioning._run_sql("DELETE FROM _emdash_api_tokens WHERE id=" + literal(token_id), env)
        raise
    if previous_id:
        provisioning._run_sql(
            "DELETE FROM _emdash_api_tokens WHERE id=" + literal(previous_id)
            + " AND name=" + literal(TOKEN_NAME)
            + " AND user_id=" + literal(provisioning.EXPECTED_USER_ID), env
        )
    print("Provisioned a 90-day scoped release-post token; credential stored only in the Private Vault.")


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args == ["--provision"]:
            provision()
            return 0
        command = normalized_args(args)
        credential = emdash.load_credential(TOKEN_FILE)
        env = emdash.child_environment(credential)
        emdash.preflight(env)
        return subprocess.run(
            ["bunx", "emdash", *command, "--url", emdash.EXPECTED_URL],
            cwd=emdash.WEB_ROOT, env=env, check=False,
        ).returncode
    except (emdash.EmDashGuardError, cloudflare.GuardError, provisioning.ProvisionError) as exc:
        print(f"Release-post guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
