# SmugMug pilot: Kyoto, 2024/06

Issue: <https://github.com/kanouk/kanouk.com/issues/5>

This directory records the completed first end-to-end migration pilot. All 60
source assets have been copied to EmDash staging and verified. The SmugMug
album, WordPress article, and DNS remain unchanged.

## Scope and URLs

- SmugMug album: <https://kanolog.smugmug.com/20240607Kyoto>
- WordPress article: <https://kanolog.net/stream/8664>
- Staging album: <https://kanouk-emdash-staging.kanouk.workers.dev/albums/2024-06-kyoto>
- Representative photo: <https://kanouk-emdash-staging.kanouk.workers.dev/photos/kph_guqcn5jdumzbrzumkdl445sl2m>
- Representative video: <https://kanouk-emdash-staging.kanouk.workers.dev/photos/kph_k4t7vz6747hzo5le5cpsvee4hu>
- Stable media URL: <https://kanouk-emdash-staging.kanouk.workers.dev/media/kph_guqcn5jdumzbrzumkdl445sl2m>

The source contains 59 JPG files and one MP4. `manifest.json` is the source to
destination ledger. `url-ledger.json` is a dry-run transformation for the ten
unique SmugMug assets embedded by the WordPress article. It records 20 URL
occurrences and leaves the source article untouched.

## Verification result

- Source/manifest/destination: 60 / 60 / 60
- Originals: 59 JPG / 1 MP4, 256,072,119 bytes total
- Source MD5 verified: 60 / 60
- Source SHA-256 recorded: 60 / 60
- Worker public-byte SHA-256 verified: 60 / 60
- Original EXIF GPS retained and structured coordinates stored: 59 / 59 JPG
- Video: original MP4, generated poster, and mobile `<video>` source verified
- Re-run result: 60 `skipped_verified`, 0 writes, 0 failures
- Desktop and 390 px mobile: album, image, video, map, previous/next navigation,
  and horizontal overflow checked
- Staging response: `X-Robots-Tag: noindex, nofollow`
- Blog article 8664 dry run: 20 URL occurrences / 10 unique assets converted,
  with zero remaining SmugMug URLs

The first image remains the representative receipt:

- Stable photo ID: `kph_guqcn5jdumzbrzumkdl445sl2m`
- EmDash album ID: `01M1BZMBG5BC5545V85X52YBB4`
- EmDash photo ID: `01M1BZNTEVB5F6M5QGA2YC2ZBB`
- EmDash media ID: `01M1C3VTGZBKFWYM4QJMX5ECP7`
- R2 storage key: `01M1C3VSX560WEC4B5R45SYKDW.jpg`
- Original MD5: `4b95832ec3aaf66d9bdea4d1f71d4c63`
- Original SHA-256: `7c72ed1a83649f0f6170182b063cf34bdeec11d415ea4d7ff36d7c01d0c70669`
- Public asset SHA-256: `7c72ed1a83649f0f6170182b063cf34bdeec11d415ea4d7ff36d7c01d0c70669`

The public EmDash media uses the verified original bytes, including GPS EXIF
and color profiles. Latitude, longitude, and altitude are stored in EmDash so
the public photo page can render its OpenStreetMap map; coordinate values are
intentionally excluded from Git. The video uses the original MP4 plus a
generated JPEG poster.

SmugMug reports `2024-06-07T13:27:33Z` for the representative asset while its
original EXIF reports `2024-06-07T06:27:33+09:00`. Both values are retained in
the manifest instead of assuming that the API timestamp is authoritative.

## Rebuild and verify

SmugMug credentials are read only by the allowlisted wrapper. The EmDash token
is scoped to staging and read only by the EmDash wrapper. Neither credential is
written to the repository or a global EmDash config file.

```sh
python3 scripts/migration/run_smugmug_readonly.py \
  migrate_smugmug_album.py \
  --manifest migration/smugmug/pilots/2024-06-kyoto/manifest.json \
  --apply

python3 scripts/migration/build_smugmug_url_ledger.py \
  --manifest migration/smugmug/pilots/2024-06-kyoto/manifest.json \
  --article /tmp/kanouk-8664.html \
  --article-id 8664 \
  --article-url https://kanolog.net/stream/8664 \
  --output migration/smugmug/pilots/2024-06-kyoto/url-ledger.json

python3 -m unittest discover -s tests -p 'test_*.py'
cd apps/web && npm run typecheck && npm run build
```

Rebuilding the manifest preserves recorded EmDash IDs, verification receipts,
and the R2 storage key for assets with the same stable ID.

## Rollback boundary

Do not delete the SmugMug source, change WordPress, or change DNS as part of
this pilot. If staging rollback is separately authorized, use the destination
IDs recorded in `manifest.json`, delete photo content before its media, then
delete the album content. No rollback has been executed.
