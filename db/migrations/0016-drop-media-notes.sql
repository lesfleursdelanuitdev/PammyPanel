-- panel.media_notes goes (docs/refactor-plan.md phase 5).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
--
-- It held who added each media file while panel.db was SQLite. The media
-- records took a copy when they were made (media.imported_notes, D17), and since
-- then nothing has read it: the only writer left was the photos/ -> images/
-- rename, which moved paths nobody looked at. The copy port that carried it into
-- Postgres and back is gone too, so no reverse port needs it either.
DROP TABLE panel.media_notes;
