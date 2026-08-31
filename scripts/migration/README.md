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
python3 scripts/migration/run_smugmug_readonly.py audit_smugmug.py \
  --user nickname \
  --output /tmp/smugmug-public-audit.json
```

The runner reads the API key from the Private Vault and passes it only to an allowlisted child process. To rank pilot albums without downloading media:

```sh
python3 scripts/migration/run_smugmug_readonly.py select_smugmug_pilot.py \
  --user nickname \
  --limit 10
```

This endpoint audits only assets readable through the public API. It does not prove owner-authenticated original download access.

To freeze a public album into a deterministic migration manifest:

```sh
python3 scripts/migration/run_smugmug_readonly.py build_smugmug_pilot_manifest.py \
  --user nickname \
  --album-key example \
  --slug 2024-06-kyoto \
  --output migration/smugmug/pilots/2024-06-kyoto/manifest.json
```

The manifest keeps the public source identity and source MD5, but excludes signed download URLs, coordinates, thumbnails, and API credentials. Public destination paths use deterministic opaque IDs and remain independent of the R2 object key.

One asset can then be downloaded into a temporary directory and checked against the frozen source MD5. The receipt contains hashes and byte counts only:

```sh
python3 scripts/migration/run_smugmug_readonly.py download_smugmug_pilot_asset.py \
  --manifest migration/smugmug/pilots/2024-06-kyoto/manifest.json \
  --asset-id kph_example \
  --output /tmp/pilot/original.jpg \
  --receipt /tmp/pilot/source-receipt.json
```

After an account-guarded R2 upload and re-download, use `record_smugmug_r2_roundtrip.py` to compare SHA-256 and update only that asset's verification state in the manifest. If an original contains EXIF that should not remain on the public-media bucket, delete the probe after verification and pass `--probe-deleted-after-verification`; the destination object key then remains unset.

`build_smugmug_url_ledger.py` extracts SmugMug page and rendition URLs from a local article, maps both to stable photo/media URLs, and optionally writes a transformed dry-run copy. It never edits the source article.

Public SmugMug photos keep their source GPS EXIF so the replacement can preserve SmugMug's map feature. Exact coordinates are stored in EmDash number fields and are never written to the Git manifest, command output, or receipts. `record_smugmug_public_derivative.py` compares the source and public file internally, refuses removed or changed GPS, and records only the preservation result, EmDash IDs, storage key, hashes, byte count, and color profile.

`apply_smugmug_pilot_gps.py` is fail-closed and dry-run by default. It checks the frozen source SHA-256 and GPS EXIF without printing coordinates. With `--apply`, it uses the account-guarded EmDash credential to upload the source bytes and update the existing photo's `latitude`, `longitude`, `altitude`, media reference, and non-coordinate source metadata. The `photos` schema must already contain those three number fields.
