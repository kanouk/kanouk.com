-- Change stamps for site-wide aggregates, and an index for per-album photo reads.
-- Additive only; 0002_change_gen.down.sql removes everything added here.
--
-- kanouk_change_gen holds one random stamp per aggregate. Triggers replace the
-- stamp whenever a row the aggregate depends on changes, so a cache keyed by the
-- stamp can be kept for hours and still turn over on the next request after an
-- edit. "terms" covers taxonomy term lists with counts (sidebar, /topics).

CREATE TABLE IF NOT EXISTS kanouk_change_gen (
	name TEXT PRIMARY KEY,
	gen TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR REPLACE INTO kanouk_change_gen (name, gen) VALUES ('terms', lower(hex(randomblob(8))));

CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_ct_insert AFTER INSERT ON content_taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_ct_update AFTER UPDATE ON content_taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_ct_delete AFTER DELETE ON content_taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;

CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_tax_insert AFTER INSERT ON taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_tax_update AFTER UPDATE ON taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_tax_delete AFTER DELETE ON taxonomies
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;

CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_def_insert AFTER INSERT ON _emdash_taxonomy_defs
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_def_update AFTER UPDATE ON _emdash_taxonomy_defs
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_def_delete AFTER DELETE ON _emdash_taxonomy_defs
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;

-- Counts include only published, non-deleted posts (per translation group and locale).
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_posts_insert AFTER INSERT ON ec_posts
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_posts_update AFTER UPDATE ON ec_posts
WHEN OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at
	OR OLD.translation_group IS NOT NEW.translation_group OR OLD.locale IS NOT NEW.locale OR OLD.id IS NOT NEW.id
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_terms_posts_delete AFTER DELETE ON ec_posts
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'terms'; END;

-- Public album pages and photo navigation read one album's published photos.
-- EmDash's own album index is on the expression (album IS NOT NULL), which D1
-- does not use for `album = ?`, so every read scanned all photos.
CREATE INDEX IF NOT EXISTS kanouk_ec_photos_album ON ec_photos (album, status) WHERE deleted_at IS NULL;
