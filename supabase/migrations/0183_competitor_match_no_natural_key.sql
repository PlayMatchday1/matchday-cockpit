-- 0183 — a facility sells several pitches at once, so (facility, date, time, format) is not a key.
--
-- ══ WHAT I GOT WRONG IN 0181 ═════════════════════════════════════════════════════════════════
-- 0181 put UNIQUE (supply_id, match_date, kickoff_local, format) on the match log. That was written
-- before the log existed, against a capture that had no matches in it, and the September log
-- refused to import against it: 14 keys, 29 rows.
--
-- Every one is real. A multi-pitch facility lists several slots at the same hour:
--
--   City Futsal, 18 Sep 22:00, 6v6  ->  "Downtown outdoor - Field 2", "Downtown futsal",
--                                       "Downtown outdoor"          (three at once)
--   Ulete, 18 Sep 20:00, 7v7        ->  "Southlake outdoor" $13.50, "Southlake indoor" $15.75
--   City Futsal The Colony, 18 Sep 22:00, 6v6 -> two cards reading "Austin ranch outdoor",
--                                       identical in every column
--
-- That last pair is why listing_title cannot rescue the key either: two pitches can carry the same
-- label. THERE IS NO NATURAL KEY, and inventing one deletes supply that was really on sale — which
-- is also, precisely, why those facilities' weekly spot totals are larger than one pitch implies.
--
-- ══ SO IDEMPOTENCY MOVES WHERE IT BELONGS ════════════════════════════════════════════════════
-- Re-importing a match log DELETES every row for the affected facilities and re-inserts, the same
-- shape the capture import already uses. A constraint is not what makes a re-import safe here; the
-- replace does, and it does not need the grain to be unique.
ALTER TABLE public.competitor_matches
  DROP CONSTRAINT IF EXISTS competitor_match_uniq;

COMMENT ON TABLE public.competitor_matches IS
  'One listing as captured. NOT unique on (facility, date, time, format): a multi-pitch facility '
  'sells several slots at the same hour and two of them can carry the same title. Re-importing a '
  'log replaces every row for the facilities it covers, which is what makes it idempotent.';
