# External link preview recovery

Some upstream sites reject Cloudflare Worker requests even when their public
HTML and OGP metadata are accessible from the local environment. On 2026-09-12,
Tabelog returned HTTP 403 to the production Worker. Changing its User-Agent did
not resolve the refusal.

The public renderer retains the last successful external OGP snapshot during
upstream failure, including after the normal stale window. Refresh and negative
cache TTLs remain unchanged. Internal targets are excluded so unpublished site
content cannot be restored from an expired external snapshot.

To recover cards for explicitly selected published articles:

```sh
python3 scripts/cloudflare/refresh_public_link_previews.py --entry-id ARTICLE_ID
python3 scripts/cloudflare/refresh_public_link_previews.py --entry-id ARTICLE_ID --apply
```

Repeat `--entry-id` for additional articles. The default command only plans the
change. The apply command uses the existing account guard, backs up affected
cache options in a private temporary JSON file, updates successful external
metadata snapshots, and verifies the stored values. It does not edit article
content or revisions. Failed fetches leave existing cache records intact.

Fetching uses the same URL, DNS, redirect, response-size and image safety checks
as the plugin. No CMS or Cloudflare credential is sent to external sites. A
successful fetch does not imply the upstream Worker refusal has been resolved.
