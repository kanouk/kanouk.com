# Unified blog and photo UX implementation

Implementation scope: issues #56, #57, #58; approved direction in #49.

## Contracts

- EmDash remains the only authoring shell. Its existing WYSIWYG editor gains related-album, album-photo, and captioned YouTube blocks.
- The explicit `yohaku.album` block is the article/album relationship. Removing it does not remove independently inserted photo blocks. Reverse links use only current published article revisions.
- Article photo blocks keep their own caption, alt text, frame and display width. Published output resolves current published Photo and Album records, never a stored preview URL.
- Existing standard images gain a Photo link only when their Media reference resolves unambiguously. This release does not bulk-rewrite historical article content or SmugMug closing sentences.
- Album return position is local to the browser session and expires after 30 minutes. Existing image size preferences override the new responsive defaults.
- Upload retries retain successful Media identity and retry Photo creation without repeating the upload. Files are memory-only; reload does not resume an upload.
- New uploads remain drafts until the existing explicit location-metadata review process is complete. This release does not add an automatic sanitizer or treat editable review metadata as tamper-resistant attestation.

## Verification before release

- Python regression suite: 172 passed.
- Web migration/compatibility suite: 115 passed.
- Public UX and organizer workflow suite: 24 passed.
- Astro check: 0 errors, warnings or hints.
- Clean `npm ci`: both EmDash admin patches apply; related-media tests pass against the freshly installed bundle.
- Real local WYSIWYG: select a photo, set article-only caption, 420px width and border, save and reopen; all values persist. YouTube caption persistence confirmed in the saved revision.
- Real local Organizer: caption-only save on a photo without a date succeeds and advances to the next photo. Failure leaves the input intact.
- Local API upload smoke: Media and draft Photo created; anonymous raw/preview requests return 404, authenticated requests return 200 with private/no-store, unreviewed publication returns 409.
- Public local navigation: photo 7 → photo 8 → close restores album anchor and focus to photo 7. Draft photos and draft reverse article links are excluded.
- Mobile article: 390px viewport has no horizontal overflow; H3/H4 are distinct and the YouTube caption is visible.

## Local reproduction

Use Node 22.13+ (or Node 24) for SQLite-backed tests. Start the existing local dev command first. The following commands never accept remote URLs or production credentials:

```sh
node scripts/seed-ux-local.mjs --confirm-local-fixtures
node scripts/verify-ux-local-api.mjs --confirm-local
```

The seed refuses to overwrite existing `ux-*` fixtures. The API smoke creates local draft fixtures and leaves them in the local database for inspection. Neither command belongs in a production deployment.

Production build, CI, deployment and public readback results must be recorded in the implementation PR before closing the release criteria.
