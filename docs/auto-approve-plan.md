# Show right away (auto-approve): plan

Status: **built 2026-09-18, release 5d87546e222dffdc, not installed yet.** Comes before the
Turnstile CAPTCHA (momolig). Q1-Q3 (section 9) were left to Claude: Q1 "Wait for my OK" /
"Show right away", Q2 yes (the hide offer is in), Q3 "Unapprove" everywhere. Built as planned,
plus: a new activity action `responses-unapproved` for the hide offer; switching back to
"Wait for my OK" needs no passkey (only choosing "Show right away" does); the choice sits under
"Responses can be approved" as a radio pair and isn't shown on the examples at all; guide 10's
PART 8 is now "The switches". Tests: gate.test.ts "forms: show right away" + a migration check,
panel.test.ts passkey/route/activity check, e2e 15-show-right-away.spec.ts, and a live
round trip in verify-panel.sh.

Today a form whose responses can be approved works one way only: a new response
arrives **not approved**, and an account holder approves it. This adds a second
way, chosen per form: a new response arrives **already approved**, and an account
holder unapproves it if it shouldn't be shown.

Nothing else about approval changes. "Approved" still means the same thing
everywhere (the `/approved` API, the keyless public read, the examples' pages);
only the state a new response starts in differs.

---

## 1. Decisions

- **D1 One new per-form setting**, only shown while "Responses can be approved" is on:

      New responses:  (•) Wait for my OK
                      ( ) Show right away -- I can hide them later

  A choice of two, not a third switch, so it reads as "which way", not "on/off".
- **D2 Default is "Wait for my OK"** for every existing form, every new form and
  every starter. Nothing starts publishing visitors' words without someone choosing it.
- **D3 Only new responses are affected.** Changing the setting never approves or
  unapproves responses already there (except via the optional offer in D8).
- **D4 An auto-approved response stays UNREAD.** Approving by hand marks a response
  read; auto-approval must not, so it still puts a red number on Responses and
  shows in Home's "waiting" count. Unread is how she notices what went live.
  (Nothing is emailed today; that stays so.)
- **D5 Auto-approval is remembered as such**, so the panel can say "shown
  automatically" and not "approved by <someone>". If someone unapproves and later
  approves it again, it becomes an ordinary approval by that person.
- **D6 Passkey check.** Choosing "Show right away" while "Anyone can read the
  approved responses" is on, or switching that on while "Show right away" is chosen,
  publishes visitors' words the moment they send them. It needs the same `recent`
  passkey check that `publicApproved` needs today.
- **D7 The three examples stay "Wait for my OK"** and don't offer the choice: the
  approve loop is their lesson, and their pages can be reached by anyone who guesses
  the address. Reset puts it back too. A **duplicate** of an example (or of any form)
  copies the setting like the other switches.
- **D8 A cleanup offer, needed because there's no CAPTCHA yet.** When she switches a
  form back to "Wait for my OK" and it has responses that were **auto-approved and
  are still unread** (nobody has looked at them), the panel asks:
  "Also hide the N responses that went up on their own and nobody has looked at yet?"
  That is the "spam got through, undo it" button. It doesn't touch anything someone
  has read or approved by hand.
- **D9 Switching approving off** keeps doing what it does now (what was approved is
  remembered, public reading goes off), and it also keeps the setting, so switching
  approving back on returns to the same way.

Existing protection that already applies without the CAPTCHA: the hidden robot trap
field, 10 sends per IP per hour, the 1,000 unread / 10,000 total caps. The panel
warning under "Show right away" says plainly that until the CAPTCHA arrives, junk
can show up on her page until she hides it.

## 2. Data (gate.db only -- `panel.db` untouched)

gate.db **migration 7** (SQL, in `GATE_MIGRATIONS`, `src/gate/store.ts`):

    ALTER TABLE forms ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE responses ADD COLUMN approved_auto INTEGER NOT NULL DEFAULT 0;

Default 0 gives every existing form D2 and every existing response its current
meaning. `install-panel.sh` already copies gate.db before migrating and checks
panel.db's schema version and passkey count.

## 3. Gate (`src/gate/forms.ts`, `examples.ts`, `admin.ts`)

- `Form` / row mapping / `summary` / `formForPanel`: add `autoApprove`.
- `setFormSwitches`: accept `autoApprove` (boolean). It may be true only when
  `approvable` is; turning approving off leaves the stored value alone (D9).
  Refuse it on a fixture (D7).
- `duplicateForm`: copy `auto_approve`.
- `addResponse`: if `form.approvable && form.autoApprove && !form.fixture`, insert with
  `approved_at = now, approved_by = NULL, approved_auto = 1` -- and leave `read_at` NULL (D4).
- `setResponseApproved`: always clear `approved_auto` (by hand from here on, D5).
- New op `form.hide-unreviewed` (D8): in one transaction,
  `UPDATE responses SET approved_at = NULL, approved_by = NULL, approved_auto = 0
   WHERE form_id = ? AND approved_auto = 1 AND read_at IS NULL AND trashed_at IS NULL`,
  returns the count. A `form.switches` answer also returns that count
  (`unreviewedAuto`) so the panel knows whether to ask.
- `toResponse` / `listResponses`: add `approvedAuto`.
- `resetExample`: set `auto_approve = 0`.
- The public API (`src/gate/app.ts`): no change. Auto-approved responses are
  approved responses.

## 4. Panel server (`src/app.ts`)

- `FormSummary` gets `autoApprove`; `POST /api/forms/:id/switches` passes it on.
- Passkey check (D6): need `recent` when the body sets `autoApprove: true` or
  `publicApproved: true` (the second is today's rule).
- New `POST /api/forms/:id/hide-unreviewed` -> the gate op; logs activity.
- Activity log wording: "new responses: shown right away" / "new responses: wait for approval",
  and "hid N responses nobody had looked at".

## 5. Panel pages (`web/src`)

- **Forms card** (`pages/Forms.tsx`): under "Responses can be approved", the D1 choice
  (radio group, works by tap on phones). Not on fixtures. The warning from section 1
  shows under "Show right away". A badge: "shown right away" beside "responses are approved".
  After switching back to "Wait for my OK", the D8 dialog if `unreviewedAuto > 0`.
- **Responses** (`pages/Responses.tsx`): an auto-approved response reads
  "approved automatically <time>" instead of "approved by ...". The Approve/Unapprove
  button and the "Approved / Not approved" filter stay as they are.
- **"Show approved answers" code intro**: one sentence that on a "Show right away" form,
  answers appear as soon as they're sent.

## 6. Guide 10 (`~/pamela-setup/forms-guide.txt` -> `10-forms.txt`)

- The switches list (around "Responses can be approved"): add "New responses: Wait for
  my OK / Show right away", what each means, that the examples always wait, and the
  CAPTCHA warning.
- Approve / Unapprove: auto-approved ones stay unread; unapprove hides one again.
- PART 11 (showing approved answers): one paragraph on choosing between the two ways
  (a guest book you trust vs. one open to anyone).
- Tutorials PART 12-14 are unchanged (examples always wait). help.test.ts pins
  PART 3 and PART 5, so no renumbering.

## 7. Tests

- gate.test.ts: migration 7 on a copy of a current gate.db (existing forms 0, existing
  approvals unchanged); send on an auto form -> approved, unread, `approved_auto`;
  on a waiting form -> not approved; fixture ignores it and refuses the switch; a
  duplicate copies it; unapprove then approve clears `approved_auto`;
  `hide-unreviewed` touches only auto + unread + not trashed; approving off keeps the setting;
  the `/approved` API returns an auto-approved response.
- panel tests: the passkey check for both orders of D6; the new route; activity wording.
- e2e: switch a form to "Show right away", send, see it on the example-style page
  without approving, see it unread; switch back, accept the D8 offer, see it gone.
  Remember: `npx vite build --config web/vite.config.ts` before e2e.
- Screenshots of the Forms card, desktop + phone.

## 8. Rollout

1. Check what release is installed first: the examples follow-up release (ed7efc8d)
   was built but not installed as of 2026-09-17. This goes on top of whatever is current.
2. `build.sh` green, then `sudo ~/pamela-setup/sync-pamela-guides.sh` and
   `sudo ~/pamela-setup/panel/deploy/install-panel.sh`.
3. verify-panel: add a check that a live form set to "Show right away" returns a fresh
   send from `/approved` straight away, then put it back and hide it.
4. Turnstile next, and after that reconsider the D8 warning text.

## 9. Open questions

- **Q1 Wording.** "Wait for my OK" / "Show right away -- I can hide them later"? Or
  "Approve each one first" / "Approve automatically"?
- **Q2 D8 in scope?** Recommended yes while there's no CAPTCHA; otherwise cleaning up
  a burst of junk is one Unapprove click per response.
- **Q3 Button name on auto forms.** Keep "Unapprove" everywhere (recommended, one
  word to learn), or say "Hide" on forms that show right away?
