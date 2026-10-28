-- 0238: a push can be CHECK FIRST: only sent if the match is still low a couple of hours before.
--
-- Pushes live one per row in match_promotion_push (0176, scope added by 0191). The flag is per
-- push, not per match or channel, because one channel can carry a regular 9:30 AM WhatsApp push
-- and a check-first 4:30 PM one on the same match.
--
-- NOT NULL DEFAULT false: every existing row reads as a regular push without being touched, and the
-- default is what a row written by code that predates this column gets too.
--
-- fin_change_log needs nothing. The save route logs the whole row as before_json / after_json, so
-- the flag is in the audit the moment the column exists.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

ALTER TABLE public.match_promotion_push
  ADD COLUMN IF NOT EXISTS check_first boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.match_promotion_push.check_first IS
  'True = only send this push if the match is still low on players a couple of hours before. '
  'False = a regular push that always goes out. Per push, so one channel can mix both.';

-- TO VERIFY. Expected: check_first_rows 0, total equal to the table count (410 on 2026-10-28).
--   select count(*) as total, count(*) filter (where check_first) as check_first_rows
--     from public.match_promotion_push;
