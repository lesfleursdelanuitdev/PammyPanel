-- docs/catalog-plan.md step 3 (S3-6, Q3-4): the media records' old tables go. The catalog
-- took them over in catalog/0001 (counts and checksums compared before commit) and they
-- have been read-only since (2026-09-28); the dump the installer took before step 2
-- (pammy-20260928T130728Z-before-ca44fda1cc1bcc10.dump, kept 60 days) still holds them.
--
-- Everything in the schema goes, not the schema itself: the early migrations (0002-media)
-- make their tables in it on a new database before catalog/0001 moves them, so
-- deploy/pg/setup.sql keeps making it, and a new database and a live one end the same:
-- an empty media schema.

-- refused if the move had somehow not happened: files in media, none in the catalog
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM media.media) AND NOT EXISTS (SELECT 1 FROM catalog.items WHERE resource_id = 1) THEN
    RAISE EXCEPTION 'media has files and the catalog has none -- nothing was dropped';
  END IF;
END $$;

DROP TABLE media.media_tags, media.media_categories, media.thumbs, media.imported_notes, media.sync_state,
  media.tags, media.categories, media.scopes, media.media;
DROP FUNCTION media.check_label_link(), media.check_label_scope(), media.check_media_scope(), media.path_under(text, text);

-- nothing left behind (a table or function this list didn't know of would be a mistake)
DO $$
DECLARE left_over text;
BEGIN
  SELECT string_agg(name, ', ') INTO left_over FROM (
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'media'
    UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'media') x;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'media still holds % -- nothing was dropped', left_over;
  END IF;
END $$;
