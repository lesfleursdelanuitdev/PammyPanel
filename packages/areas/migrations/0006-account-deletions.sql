-- Accounts deleted, to be passed on to the apps (docs/accounts-plan.md Q1, "Step 4b: as built"):
-- the panel tells every service behind a route with accounts that declares the hook (services
-- known.ts accountDeleted), signed, and retries until each has answered. Every way an account
-- goes (an owner, the person themselves, an unconfirmed one after 48 hours, a registration
-- taken back) is a DELETE on gate.visitors, so a trigger notes it in the same transaction.
-- told: the services that have answered; next_at: when to try again (seconds, as the gate's
-- other times). The gate's housekeeping drops a row after 30 days, told or not (pammy.org
-- has no services, so its rows are never passed on).
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.
CREATE TABLE gate.deleted_accounts (
  visitor_id bigint  PRIMARY KEY,
  username   text    NOT NULL,
  deleted_at bigint  NOT NULL,
  told       text[]  NOT NULL DEFAULT '{}',
  tries      integer NOT NULL DEFAULT 0,
  next_at    bigint  NOT NULL,
  last_error text
);
CREATE INDEX deleted_accounts_next ON gate.deleted_accounts (next_at);

CREATE FUNCTION gate.note_deleted_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gate.deleted_accounts (visitor_id, username, deleted_at, next_at)
  VALUES (OLD.id, OLD.username, extract(epoch FROM now())::bigint, extract(epoch FROM now())::bigint)
  ON CONFLICT (visitor_id) DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER visitors_deleted AFTER DELETE ON gate.visitors
  FOR EACH ROW EXECUTE FUNCTION gate.note_deleted_account();
