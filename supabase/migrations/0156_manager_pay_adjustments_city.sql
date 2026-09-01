-- ADD ONE COLUMN so a manager with NO matches in the week can be paid.
--
-- ── WHY THIS IS THE ONLY THING MISSING ───────────────────────────────────────
-- manager_pay_adjustments already holds everything an added person needs:
--   manager_email  identity, and the key the whole pay path joins on
--   week_start     the scope
--   amount         the money
--   notes          the reason (already free text, already nullable)
--   UNIQUE (manager_email, week_start)   the duplicate guard, already stronger
--                                        than per-city: one row per person per
--                                        week, full stop.
--
-- What does NOT work today is placement. src/lib/managerPayCompute.ts builds
-- every ManagerRow from addAssignment(), which is called only while walking the
-- week's MATCHES, and it derives cityIdentifier as the DOMINANT CITY OF THOSE
-- MATCHES. A manager with zero matches produces no accumulator, so no row, so
-- the adjustment is read out of this table and then has nothing to attach to
-- and no city to sit in. It is silently dropped.
--
-- city_identifier is therefore the missing piece, and it is the only one.
--
-- ── NULLABLE, AND THE NULL MEANS SOMETHING ───────────────────────────────────
-- NULL = "this adjustment belongs to a manager who IS on the schedule" — the
-- existing inline Additional Pay cell. Its city keeps coming from the matches,
-- exactly as before, and every existing row keeps behaving identically.
-- NON-NULL = "this row was added by the not-on-the-schedule control", which is
-- also what tells the page to render it as a zero-match row with a delete
-- control. No second boolean is needed: the city IS the marker, and a marker
-- that is also load-bearing data cannot drift out of step with itself.
--
-- No DEFAULT and no backfill, deliberately. Defaulting to a city would invent a
-- placement for 0 rows that never had one.
--
-- notes stays NULLABLE at the database level. The reason is REQUIRED for added
-- rows and that is enforced in the route, not here — a NOT NULL constraint
-- would reject the existing inline rows that legitimately carry no note.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE manager_pay_adjustments
  ADD COLUMN IF NOT EXISTS city_identifier TEXT;

-- The page reads one week at a time and then filters by city in memory; this
-- index exists so the "does this person already have a row this week" check and
-- the per-week read stay cheap as the table grows.
CREATE INDEX IF NOT EXISTS manager_pay_adjustments_week_city_idx
  ON manager_pay_adjustments (week_start, city_identifier);
