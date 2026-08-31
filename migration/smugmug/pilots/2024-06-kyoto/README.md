# SmugMug pilot: Kyoto, 2024/06

Issue: <https://github.com/kanouk/kanouk.com/issues/5>

This directory records the first end-to-end migration pilot. The SmugMug album
and WordPress article remain unchanged. Only one of the 60 source assets has
been copied to EmDash staging; this is not a completed album migration.

## Scope and URLs

- SmugMug album: <https://kanolog.smugmug.com/20240607Kyoto>
- WordPress article: <https://kanolog.net/stream/8664>
- Staging album: <https://kanouk-emdash-staging.kanouk.workers.dev/albums/2024-06-kyoto>
- Staging photo: <https://kanouk-emdash-staging.kanouk.workers.dev/photos/kph_guqcn5jdumzbrzumkdl445sl2m>
- Stable staging media URL: <https://kanouk-emdash-staging.kanouk.workers.dev/media/kph_guqcn5jdumzbrzumkdl445sl2m>

The source contains 59 JPG files and one MP4. `manifest.json` is the source to
destination ledger. `url-ledger.json` is a dry-run transformation for the ten
unique SmugMug assets embedded by the WordPress article. It records 20 URL
occurrences and leaves the source article untouched.

## Verified representative asset

- Stable photo ID: `kph_guqcn5jdumzbrzumkdl445sl2m`
- EmDash album ID: `01M1BZMBG5BC5545V85X52YBB4`
- EmDash photo ID: `01M1BZNTEVB5F6M5QGA2YC2ZBB`
- EmDash media ID: `01M1C3VTGZBKFWYM4QJMX5ECP7`
- R2 storage key: `01M1C3VSX560WEC4B5R45SYKDW.jpg`
- Original MD5: `4b95832ec3aaf66d9bdea4d1f71d4c63`
- Original SHA-256: `7c72ed1a83649f0f6170182b063cf34bdeec11d415ea4d7ff36d7c01d0c70669`
- Public asset SHA-256: `7c72ed1a83649f0f6170182b063cf34bdeec11d415ea4d7ff36d7c01d0c70669`

The raw-object R2 probe returned the original bytes and was deleted after the
round-trip check. The public EmDash media now uses the verified original bytes,
including GPS EXIF and the sRGB ICC profile. Latitude, longitude, and altitude
are stored in EmDash so the public photo page can render its OpenStreetMap map;
the coordinate values themselves are intentionally excluded from Git. The
bytes downloaded through the staging Worker must match the public asset
SHA-256 and retain GPS EXIF.

SmugMug reports `2024-06-07T13:27:33Z` for the representative asset while its
original EXIF reports `2024-06-07T06:27:33+09:00`. Both values are retained in
the manifest instead of assuming that the API timestamp is authoritative.

## Rebuild and verify

SmugMug credentials are read only by the allowlisted wrapper. The EmDash token
is scoped to staging and read only by the EmDash wrapper. Neither credential is
written to the repository or a global EmDash config file.

```sh
python3 scripts/migration/run_smugmug_readonly.py \
  build_smugmug_pilot_manifest.py \
  --user kanolog \
  --album-key phhvSP \
  --slug 2024-06-kyoto \
  --output migration/smugmug/pilots/2024-06-kyoto/manifest.json

python3 scripts/migration/build_smugmug_url_ledger.py \
  --manifest migration/smugmug/pilots/2024-06-kyoto/manifest.json \
  --article /tmp/kanouk-8664.html \
  --article-id 8664 \
  --article-url https://kanolog.net/stream/8664 \
  --output migration/smugmug/pilots/2024-06-kyoto/url-ledger.json

python3 scripts/migration/apply_smugmug_pilot_gps.py \
  --file /path/to/verified-original.jpg \
  --content-id 01M1BZNTEVB5F6M5QGA2YC2ZBB \
  --expected-sha256 7c72ed1a83649f0f6170182b063cf34bdeec11d415ea4d7ff36d7c01d0c70669 \
  --apply

python3 -m unittest discover -s tests -p 'test_*.py'
cd apps/web && npm run typecheck && npm run build
```

Rebuilding the manifest preserves recorded EmDash IDs, verification receipts,
and the R2 storage key for assets with the same stable ID.

## Rollback the staging sample

Do not run these commands during ordinary verification. They remove the pilot
content and the uploaded public derivative from staging. Delete content before
the media object:

```sh
python3 scripts/cloudflare/run_emdash_kanouk.py \
  content delete photos 01M1BZNTEVB5F6M5QGA2YC2ZBB --json

python3 scripts/cloudflare/run_emdash_kanouk.py \
  content delete albums 01M1BZMBG5BC5545V85X52YBB4 --json

python3 scripts/cloudflare/run_emdash_kanouk.py \
  media delete 01M1C3VTGZBKFWYM4QJMX5ECP7 --json
```

After rollback, verify that the album and photo return 404 and that the stable
media route no longer resolves. The route implementation itself can remain;
without a photo record it has no source storage key to redirect to.
