-- "posts" change stamp for post archive aggregates (month list, calendar days).
-- Requires 0002_change_gen (kanouk_change_gen). Additive only; 0003_posts_gen.down.sql removes it.
-- The stamp turns over whenever a post enters or leaves the published set or
-- its publication date moves.

INSERT OR REPLACE INTO kanouk_change_gen (name, gen) VALUES ('posts', lower(hex(randomblob(8))));

CREATE TRIGGER IF NOT EXISTS kanouk_gen_posts_insert AFTER INSERT ON ec_posts
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'posts'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_posts_update AFTER UPDATE ON ec_posts
WHEN OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at
	OR OLD.published_at IS NOT NEW.published_at OR OLD.id IS NOT NEW.id
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'posts'; END;
CREATE TRIGGER IF NOT EXISTS kanouk_gen_posts_delete AFTER DELETE ON ec_posts
BEGIN UPDATE kanouk_change_gen SET gen = lower(hex(randomblob(8))) WHERE name = 'posts'; END;
