-- 0181 — the match log, and the two things 0179 assumed about it that are not true.
--
-- 0179 created competitor_matches from a capture that had no match log, so its shape was a guess.
-- The September log arrived with 685 rows and contradicted it twice.
--
-- ══ A LISTING CAN HAVE NO TIME ═══════════════════════════════════════════════════════════════
-- kickoff_local was `time NOT NULL`. One row in the log is a Foro Sports Club listing on 18 Sep
-- whose time was cut off in the recording: the match is real, the spots are real and counted in the
-- facility's weekly total, and the hour is simply not known. NOT NULL leaves two options, both
-- wrong: drop the row, which breaks the sum that validates the whole capture, or invent a time.
-- It becomes nullable, and the page sorts a timeless listing LAST in its day rather than at
-- midnight, because unknown is not 00:00.
ALTER TABLE public.competitor_matches ALTER COLUMN kickoff_local DROP NOT NULL;

-- ══ AND THE UNIQUE KEY HAS TO SURVIVE THAT ═══════════════════════════════════════════════════
-- Postgres treats NULLs as distinct in a unique index, so the moment kickoff_local can be null the
-- old constraint stops preventing a duplicate of exactly the row that needed it most. NULLS NOT
-- DISTINCT makes two timeless listings on the same day and format collide, which is what they are.
ALTER TABLE public.competitor_matches
  DROP CONSTRAINT IF EXISTS competitor_match_uniq;
ALTER TABLE public.competitor_matches
  ADD CONSTRAINT competitor_match_uniq
  UNIQUE NULLS NOT DISTINCT (supply_id, match_date, kickoff_local, format);

-- ══ THE NOTE IS EVIDENCE, NOT DECORATION ═════════════════════════════════════════════════════
-- It carries the level ("Intermediate", "High-level") and, on a handful of rows, the explanation
-- for a spots-per-match figure that looks impossible: "Listed max 75 spots (multi-team or open-play
-- format)", "Intermediate. 90 min, 28 spots", "Free game, 2 hrs, 35 spots". Those are the rows that
-- made Memorial Indoor look like 35 players in a 5v5, and without the note the only reading left is
-- that the capture is wrong.
ALTER TABLE public.competitor_matches ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.competitor_matches.kickoff_local IS
  'Wall clock at the pitch, as listed. NULL means the listing was captured without a time, which is '
  'not midnight: the page sorts those last in their day.';
COMMENT ON COLUMN public.competitor_matches.note IS
  'As captured. Carries the level and, where present, why a spots figure does not match its format '
  '(multi-team, open play, double slot, free game).';
COMMENT ON COLUMN public.competitor_matches.price_cents IS
  'Per player. NULL means nothing was published, which is NOT zero. A genuine free game is 0 and '
  'the September log has exactly one: Vaqueros Field, 20 Sep, annotated "Free game, 2 hrs".';
