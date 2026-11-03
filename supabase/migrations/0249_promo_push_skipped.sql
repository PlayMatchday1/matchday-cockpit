-- 0249: a check-first push can be SKIPPED: the operator checked, the match was full enough, and the
-- push is deliberately not sent.
--
-- Skipped is not sent. pushed_at means "a human says it went out", and a skipped push did not, so
-- it gets its own stamp rather than borrowing that one. Both NULL = still to do.
--
-- Nullable, no default: every existing row reads as not skipped without being touched.
--
-- fin_change_log needs nothing. The route logs the whole row as before_json / after_json, so the
-- stamp is in the audit the moment the column exists.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

ALTER TABLE public.match_promotion_push
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_by text;

COMMENT ON COLUMN public.match_promotion_push.skipped_at IS
  'When somebody decided not to send this check-first push. NULL = not skipped. Never set together with pushed_at.';
COMMENT ON COLUMN public.match_promotion_push.skipped_by IS
  'Who skipped it: the signed-in email, the same identity pushed_by takes.';

-- TO VERIFY. Expected: skipped_rows 0, total equal to the table count.
--   select count(*) as total, count(*) filter (where skipped_at is not null) as skipped_rows
--     from public.match_promotion_push;
