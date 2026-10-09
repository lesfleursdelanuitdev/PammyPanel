-- Monitoring (docs/monitoring-plan.md step 1): each check's state now, every change kept
-- 90 days, quiet for maintenance, and the monitoring emails sent each day. A check that
-- passes every round writes nothing new: the state row only moves when something does.
-- Every site gets the tables; only a site with the monitoring module on (lfdln) writes.
--
-- Appended, never edited: tools/migrate.ts refuses a file whose checksum changed.

-- One row per check, by its key ("host:tutor.lesfleursdelanuit.com",
-- "service:gonsalves/public", "panel:gate"). state: up; down (failed twice in a row);
-- warn (works, but look soon); stopped (on purpose: a part stopped from the panel, a host
-- switched off). fails: failures in a row, so the first one only counts.
CREATE TABLE panel.monitor_checks (
  key         text    PRIMARY KEY CHECK (length(key) <= 300),
  grp         text    NOT NULL CHECK (grp ~ '^[a-z]{1,20}$'),
  subject     text    NOT NULL CHECK (length(subject) <= 300),
  label       text    NOT NULL CHECK (length(label) <= 300),
  state       text    NOT NULL CHECK (state IN ('up', 'down', 'warn', 'stopped')),
  fails       integer NOT NULL DEFAULT 0 CHECK (fails >= 0),
  since       bigint  NOT NULL,
  last_at     bigint  NOT NULL,
  why         text    NOT NULL DEFAULT '' CHECK (length(why) <= 500),
  link        text    CHECK (length(link) <= 300),
  -- still down: the last time an email said so (one reminder a day, Q3)
  reminded_at bigint
);

-- What changed, and when: down, back, warn, stopped, started, still-down; quiet-start
-- and quiet-end (subject only). Kept 90 days (Q8).
CREATE TABLE panel.monitor_events (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key     text   NOT NULL,
  label   text   NOT NULL,
  kind    text   NOT NULL CHECK (kind IN ('down', 'back', 'warn', 'stopped', 'started', 'still-down')),
  why     text   NOT NULL DEFAULT '',
  at      bigint NOT NULL,
  -- mailed, held back (the day's limit), or not for mail (quiet, stopped on purpose)
  mail    text   NOT NULL DEFAULT 'no' CHECK (mail IN ('sent', 'held', 'no', 'quiet'))
);
CREATE INDEX monitor_events_at ON panel.monitor_events (at);
CREATE INDEX monitor_events_key ON panel.monitor_events (key, at);

-- Quiet for maintenance: a subject (a host's address, "service:<id>", "panel") or
-- everything ("all"), until a time. Checked and shown, not mailed.
CREATE TABLE panel.monitor_quiet (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject    text   NOT NULL CHECK (length(subject) <= 300),
  until      bigint NOT NULL,
  created_by text,
  created_at bigint NOT NULL,
  ended_at   bigint
);

-- The monitoring emails of a day (UTC): at most 10 (Q2), the last saying so.
CREATE TABLE panel.monitor_mail (
  day  date    PRIMARY KEY,
  sent integer NOT NULL DEFAULT 0,
  held integer NOT NULL DEFAULT 0
);

-- Mail on or off (admins), and the last round: when it ran, how long it took.
CREATE TABLE panel.monitor_settings (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mail       boolean NOT NULL DEFAULT true,
  round_at   bigint,
  round_ms   integer,
  round_note text
);
INSERT INTO panel.monitor_settings (id) VALUES (1);
