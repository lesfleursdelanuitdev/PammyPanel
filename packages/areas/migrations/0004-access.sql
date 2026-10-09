-- The Access page (docs/roles-plan.md step 4): a folder's own copy of a
-- built-in role set, combined roles, and the roles switch on Settings >
-- Visitors (off by default: pammy.org sees today's Protected folders page).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- R4: a copy belongs to its area, and remembers the set it was copied from
-- (so the area can go back to it)
ALTER TABLE gate.role_sets
  ADD COLUMN area_id     bigint REFERENCES gate.areas(id) ON DELETE CASCADE,
  ADD COLUMN copied_from bigint REFERENCES gate.role_sets(id) ON DELETE SET NULL,
  ADD CONSTRAINT role_sets_copy_of_area CHECK (NOT built_in OR area_id IS NULL);
CREATE UNIQUE INDEX role_sets_one_copy_per_area ON gate.role_sets (area_id) WHERE area_id IS NOT NULL;

-- R3: a combined role is made of plain roles of its own set; its privileges are
-- theirs, worked out live. (That the parts are plain, and never a pair on the
-- never-together list, is checked where it's written.)
CREATE TABLE gate.role_parts (
  role_id     bigint NOT NULL,
  part_id     bigint NOT NULL,
  role_set_id bigint NOT NULL,
  PRIMARY KEY (role_id, part_id),
  CHECK (role_id <> part_id),
  FOREIGN KEY (role_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE,
  FOREIGN KEY (part_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE
);

-- a role's privileges: its own, its groups', and, for a combined role, its parts'
CREATE OR REPLACE VIEW gate.role_all_privileges AS
  WITH direct AS (
    SELECT role_id, privilege FROM gate.role_privileges
    UNION
    SELECT rg.role_id, gp.privilege FROM gate.role_groups rg JOIN gate.group_privileges gp ON gp.group_id = rg.group_id
  )
  SELECT role_id, privilege FROM direct
  UNION
  SELECT rp.role_id, d.privilege FROM gate.role_parts rp JOIN direct d ON d.role_id = rp.part_id;

-- moving a folder onto its own copy (or back) changes its memberships' set and
-- role together, inside one transaction
ALTER TABLE gate.memberships
  ALTER CONSTRAINT memberships_area_id_role_set_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT memberships_role_id_role_set_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

-- Settings > Visitors: roles and privileges on the Access page (A5: off)
ALTER TABLE gate.visitor_settings ADD COLUMN roles boolean NOT NULL DEFAULT false;
