-- Drop the city_identifier CHECK from city_manager_check_ins (added in 0167, one day earlier).
--
-- WHY IT GOES. 0167's own header argued both sides and landed on the wrong one. src/lib/cityScope.ts
-- had already settled this question about this exact column: migration 0120 deliberately put NO
-- CHECK on city_identifier because "a CHECK listing today's seven abbreviations is a migration
-- every time a city opens", and the allowlist lives in code "enforced by the route: adding a city
-- is a one-line edit rather than a migration". 0167 reversed that for one table while the rest of
-- the estate kept the original rule.
--
-- TWO LISTS DRIFT, AND THIS PAIR DRIFTS IN THE WORST DIRECTION. The day a ninth city opens someone
-- adds the cityScope.ts line, the route starts accepting it, the manager fills the form standing on
-- a pitch, submits — and Postgres refuses on a constraint nobody remembered. The route validated
-- fine, so it surfaces as a 500 carrying a constraint name, and the city manager finds out by not
-- getting a check-in.
--
-- THE TYPO CASE IT WAS DEFENDING IS ALREADY COVERED. Free text cannot reach this column: the submit
-- route compares against CITY_SCOPES before inserting and refuses with a message. The CHECK only
-- ever caught a writer that bypassed the route, and there is none — anon has no policies on this
-- table at all, and the route holds the only service_role key. scripts/check-in-form-test.ts pins
-- the refusal, deriving the accepted set from CITY_SCOPES so it cannot go stale when a city opens.
--
-- WHAT STAYS. The rating and length constraints are NOT touched. Those constrain the SHAPE of a
-- value — a rating is 1-5 because the scale is 1-5, an answer has a length cap because a public
-- endpoint takes arbitrary input — and neither is a list that changes when the business grows.
-- That is the line: shape in the database, membership in code.

ALTER TABLE city_manager_check_ins
  DROP CONSTRAINT IF EXISTS city_manager_check_ins_city_check;

-- city_identifier stays NOT NULL. Dropping the list does not make the column optional.
