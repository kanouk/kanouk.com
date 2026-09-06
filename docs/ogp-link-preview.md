# Article social previews and link cards

## Authoring contract

- Keep the existing EmDash WYSIWYG and its SEO panel.
- A link-card URL starts a bounded metadata lookup. Title, description, and image remain editable; a failed lookup must not prevent manual saving.
- Ignore responses for a previous URL or closed editor. Automatic results must not replace intervening manual edits.
- Persist the selected metadata with the block, so public page rendering does not depend on a remote website being available.

## Public rendering

- Resolve internal article metadata from published CMS content using the same social-preview rules as the article itself.
- Preserve deliberate card copy and fill missing values from metadata. External cards may use previously fetched metadata from the cache; public visits do not initiate arbitrary external fetches.
- Prefer explicitly selected article SEO images, then article cover/body imagery, then a local fallback. Translate old WordPress image references only through exact migration identities; do not guess by filename.
- Never expose draft-only or location-unreviewed photo media through social previews.

## Fetch boundary

- The lookup endpoint is editor-authenticated, POST-only, and CSRF-protected.
- HTTPS only, public DNS destinations, bounded manual redirects, bounded response bytes, timeout, and HTML-only parsing. Never forward ambient cookies or authorization.
- External HTML is treated as data, not rendered markup. No image proxy is added.
- DNS validation is defense in depth. Cloudflare global fetch supplies the deployment's network boundary; this is not a claim of application-level socket pinning. See [Cloudflare's explanation of global fetch and bindings](https://blog.cloudflare.com/workers-environment-live-object-bindings/).

## Release verification

Record automated tests, native editor save/reopen checks, unauthorized lookup rejection, external metadata lookup, internal article metadata, and public readback in the implementation PR.
