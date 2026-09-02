-- One-time convergence for the existing single-locale Japanese site.
-- Precondition verified on 2026-09-02: all affected rows used locale `en`
-- only because EmDash was initialized without an explicit Astro i18n locale.

UPDATE ec_posts SET locale = 'ja' WHERE locale = 'en';
UPDATE ec_pages SET locale = 'ja' WHERE locale = 'en';
UPDATE ec_albums SET locale = 'ja' WHERE locale = 'en';
UPDATE ec_photos SET locale = 'ja' WHERE locale = 'en';
UPDATE ec_url_mappings SET locale = 'ja' WHERE locale = 'en';

UPDATE _emdash_bylines SET locale = 'ja' WHERE locale = 'en';
UPDATE _emdash_menus SET locale = 'ja' WHERE locale = 'en';
UPDATE _emdash_menu_items SET locale = 'ja' WHERE locale = 'en';
UPDATE _emdash_relations SET locale = 'ja' WHERE locale = 'en';
UPDATE _emdash_taxonomy_defs SET locale = 'ja' WHERE locale = 'en';
UPDATE taxonomies SET locale = 'ja' WHERE locale = 'en';

UPDATE content_taxonomies SET locale = 'ja' WHERE locale = 'en';
UPDATE _emdash_media_usage_sources SET locale = 'ja' WHERE locale = 'en';
