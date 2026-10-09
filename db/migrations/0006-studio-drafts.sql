-- The schema she has drawn but not applied yet (docs/databases-plan.md 15
-- `studio_drafts`, docs/studio-plan.md "draft is one JSON document").
--
-- One row per database, holding the whole desired schema as one document rather
-- than dozens of rows the panel would have to keep in step with each other. The
-- Tables page, and the canvas when it arrives, are two surfaces on this one
-- document -- which is what makes "either side can add a field and the other
-- updates" true rather than a feature to build twice (docs/databases-plan.md 10).
--
-- Nothing here is her data, and nothing here is a schema that exists. The live
-- schema is read from the engine every time it is needed and is never stored as
-- the working copy: `based_on` is the only thing kept about it, and only so the
-- panel can notice the database moved underneath the draft (drift, plan 8).
--
-- S9, until 2026-09-26: the foreign key here points at `studio_databases`, which
-- arrived in 0004 and is NOT one of the ported tables. A rollback and re-port
-- has to empty `panel.users`, `panel.sessions`, `media.*` and `gate.*`
-- (src/port.ts:241 refuses a non-empty one), and nothing in this file reaches
-- any of them, so that emptying is unaffected. It cascades from a studio row to
-- its draft, which is right: a database the panel has stopped looking after has
-- no draft.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

CREATE TABLE panel.studio_drafts (
  -- one draft per database: two managers editing it is last-write-wins on this
  -- row, with `updated_by` and `updated_at` saying who got there last
  database_id bigint PRIMARY KEY REFERENCES panel.studio_databases (id) ON DELETE CASCADE,
  -- the whole desired schema, as the IR has it (src/pammydb/ir.ts Snapshot)
  draft_json  text   NOT NULL,
  -- the hash of the live schema this was started from (ir.ts snapshotHash).
  -- Apply sends it back to the helper, which refuses if the database has moved.
  based_on    text   NOT NULL,
  updated_at  bigint NOT NULL,
  updated_by  text   NOT NULL DEFAULT ''
);
