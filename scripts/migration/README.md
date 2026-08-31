# Migration audit scripts

These scripts aggregate source schema and usage signals without persisting post bodies, titles, slugs, user names, media files, or credentials.

## WordPress REST

Public-only:

```sh
python3 scripts/migration/audit_wordpress.py rest \
  --site https://example.com \
  --output /tmp/wordpress-rest-audit.json
```

Authenticated read-only audit:

```sh
WP_AUDIT_USER='...' WP_AUDIT_PASSWORD='...' \
python3 scripts/migration/audit_wordpress.py rest \
  --site https://example.com \
  --username-env WP_AUDIT_USER \
  --password-env WP_AUDIT_PASSWORD \
  --output /tmp/wordpress-rest-audit.json
```

Use a WordPress Application Password. Do not place credentials in arguments, config files in this repository, or generated reports.

## WordPress WXR

```sh
python3 scripts/migration/audit_wordpress.py wxr export.xml \
  --output /tmp/wordpress-wxr-audit.json
```

## SmugMug public API

```sh
SMUGMUG_API_KEY='...' \
python3 scripts/migration/audit_smugmug.py \
  --user nickname \
  --output /tmp/smugmug-public-audit.json
```

This endpoint audits only assets readable through the public API. It does not prove owner-authenticated original download access.
