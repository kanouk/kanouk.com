-- Derived reference index for public-media checks, article photo links and
-- album related articles (src/utils/ref-index.mjs). Additive only; undo with
-- 0001_ref_index.down.sql. Triggers mark every entry whose answer may change
-- as dirty in the writing transaction; readers fall back to the full scan
-- while anything is dirty, and the Worker drains the queue.
CREATE TABLE IF NOT EXISTS kanouk_ref_index (
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	PRIMARY KEY (kind, value, source, source_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS kanouk_ref_index_source ON kanouk_ref_index (source, source_id);
CREATE TABLE IF NOT EXISTS kanouk_ref_dirty (
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	stamp TEXT NOT NULL,
	PRIMARY KEY (source, source_id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_posts_insert AFTER INSERT ON ec_posts
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('posts', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_posts_update AFTER UPDATE ON ec_posts
WHEN NEW.status IS NOT OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.live_revision_id IS NOT OLD.live_revision_id OR NEW.id IS NOT OLD.id
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('posts', OLD.id, lower(hex(randomblob(8))));
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('posts', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_posts_delete AFTER DELETE ON ec_posts
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('posts', OLD.id, lower(hex(randomblob(8))));
END;

CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_pages_insert AFTER INSERT ON ec_pages
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('pages', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_pages_update AFTER UPDATE ON ec_pages
WHEN NEW.status IS NOT OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.live_revision_id IS NOT OLD.live_revision_id OR NEW.id IS NOT OLD.id
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('pages', OLD.id, lower(hex(randomblob(8))));
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('pages', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_pages_delete AFTER DELETE ON ec_pages
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('pages', OLD.id, lower(hex(randomblob(8))));
END;

CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_albums_insert AFTER INSERT ON ec_albums
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('albums', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_albums_update AFTER UPDATE ON ec_albums
WHEN NEW.status IS NOT OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.live_revision_id IS NOT OLD.live_revision_id OR NEW.id IS NOT OLD.id
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('albums', OLD.id, lower(hex(randomblob(8))));
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('albums', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_albums_delete AFTER DELETE ON ec_albums
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('albums', OLD.id, lower(hex(randomblob(8))));
END;

CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_photos_insert AFTER INSERT ON ec_photos
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('photos', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_photos_update AFTER UPDATE ON ec_photos
WHEN NEW.status IS NOT OLD.status OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.live_revision_id IS NOT OLD.live_revision_id OR NEW.id IS NOT OLD.id OR NEW.draft_revision_id IS NOT OLD.draft_revision_id
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('photos', OLD.id, lower(hex(randomblob(8))));
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('photos', NEW.id, lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_photos_delete AFTER DELETE ON ec_photos
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('photos', OLD.id, lower(hex(randomblob(8))));
END;

-- Revision data is read through the entry's live (and, for photos, draft)
-- pointer, so a change to a pointed-to revision dirties the pointing entries.
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_revision_insert AFTER INSERT ON revisions
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'posts', id, lower(hex(randomblob(8))) FROM ec_posts WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'pages', id, lower(hex(randomblob(8))) FROM ec_pages WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'albums', id, lower(hex(randomblob(8))) FROM ec_albums WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'photos', id, lower(hex(randomblob(8))) FROM ec_photos WHERE live_revision_id = NEW.id OR draft_revision_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_revision_update AFTER UPDATE ON revisions
WHEN NEW.data IS NOT OLD.data OR NEW.id IS NOT OLD.id
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'posts', id, lower(hex(randomblob(8))) FROM ec_posts WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'pages', id, lower(hex(randomblob(8))) FROM ec_pages WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'albums', id, lower(hex(randomblob(8))) FROM ec_albums WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'photos', id, lower(hex(randomblob(8))) FROM ec_photos WHERE live_revision_id = OLD.id OR draft_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'posts', id, lower(hex(randomblob(8))) FROM ec_posts WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'pages', id, lower(hex(randomblob(8))) FROM ec_pages WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'albums', id, lower(hex(randomblob(8))) FROM ec_albums WHERE live_revision_id = NEW.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'photos', id, lower(hex(randomblob(8))) FROM ec_photos WHERE live_revision_id = NEW.id OR draft_revision_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_revision_delete AFTER DELETE ON revisions
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'posts', id, lower(hex(randomblob(8))) FROM ec_posts WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'pages', id, lower(hex(randomblob(8))) FROM ec_pages WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'albums', id, lower(hex(randomblob(8))) FROM ec_albums WHERE live_revision_id = OLD.id;
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp)
		SELECT 'photos', id, lower(hex(randomblob(8))) FROM ec_photos WHERE live_revision_id = OLD.id OR draft_revision_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_options_insert AFTER INSERT ON options
WHEN NEW.name = 'site:seo'
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('options', 'site:seo', lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_options_update AFTER UPDATE ON options
WHEN (NEW.name = 'site:seo' OR OLD.name = 'site:seo') AND (NEW.value IS NOT OLD.value OR NEW.name IS NOT OLD.name)
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('options', 'site:seo', lower(hex(randomblob(8))));
END;
CREATE TRIGGER IF NOT EXISTS kanouk_ref_dirty_options_delete AFTER DELETE ON options
WHEN OLD.name = 'site:seo'
BEGIN
	INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('options', 'site:seo', lower(hex(randomblob(8))));
END;
-- Backfill: every existing entry starts dirty; the Worker's drain builds the index.
INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) SELECT 'posts', id, lower(hex(randomblob(8))) FROM ec_posts;
INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) SELECT 'pages', id, lower(hex(randomblob(8))) FROM ec_pages;
INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) SELECT 'albums', id, lower(hex(randomblob(8))) FROM ec_albums;
INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) SELECT 'photos', id, lower(hex(randomblob(8))) FROM ec_photos;
INSERT OR REPLACE INTO kanouk_ref_dirty (source, source_id, stamp) VALUES ('options', 'site:seo', lower(hex(randomblob(8))));
