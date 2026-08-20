-- ONE RESERVATION PER TIME SLOT — a per-venue booking-unit flag.
--
-- WHY. Cost for a per-match venue is matchCount × rate (financeCosts.ts:136), and matchCount
-- counts SCHEDULE ROWS. Where a venue books one pitch for a slot and runs two matches in it, we
-- pay once and are charged twice. Measured on Westlake (fin_venues 49, mdapi field 1): 226 matches
-- across 174 distinct (field, start) slots — 52 matches in excess, four of the slots carrying
-- three or four matches at one time, so this is a DISTINCT-SLOT count and never a halving.
--
-- DEFAULT false IS THE POINT. Every venue, Westlake included, keeps today's arithmetic when this
-- lands. Nothing restates on deploy. Ticking the box is a separate, deliberate act by Ryan, after
-- he has read the numbers — and it moves closed months, including reported ones.
--
-- This migration sets the column and nothing else. It does NOT turn the flag on for any venue.
ALTER TABLE public.fin_venues
  ADD COLUMN IF NOT EXISTS bills_per_reservation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fin_venues.bills_per_reservation IS
  'When true, per-match cost counts DISTINCT (mdapi_field_id, match_date, match_time) slots instead of match rows — the venue bills per reservation, not per match. Default false preserves existing arithmetic.';
