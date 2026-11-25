DROP TRIGGER IF EXISTS kanouk_gen_posts_insert;
DROP TRIGGER IF EXISTS kanouk_gen_posts_update;
DROP TRIGGER IF EXISTS kanouk_gen_posts_delete;
DELETE FROM kanouk_change_gen WHERE name = 'posts';
