-- 0270 — Credits: each closed month of the player credits report, stored once (Ryan, 2026-11-10).
--
-- WHY. Finance › Credits › Monthly rebuilt every month from the bookings on every load (about 20 seconds). A month
-- that is over cannot gain cancellation credits or credit spends (each is dated by its match, its cancellation or
-- its booking), so the night run stores its figures here once, CLOSE_AFTER_DAYS (2) after it ends, and the page
-- rebuilds only the months still open. Written by /api/sync/credit-balance-snapshot (lib/creditsReportLoad
-- closeCreditMonths) from the same rebuild the page ran; a stored row is never rewritten.
--
--   month                 'YYYY-MM', Central
--   match_cancel_cents    credits from matches we cancelled, dated by the match
--   player_cancel_cents   credits from players cancelling more than 24 hours ahead, dated by the cancellation
--   staff_cents           staff credits (the Staff tab's net, less Warsaw players and test accounts)
--   used_cents            credit spent on PAID bookings, dated by the booking

BEGIN;

CREATE TABLE IF NOT EXISTS public.credit_months (
  month                text        PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  match_cancel_cents   bigint      NOT NULL,
  player_cancel_cents  bigint      NOT NULL,
  staff_cents          bigint      NOT NULL,
  used_cents           bigint      NOT NULL,
  closed_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_months ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_months FROM anon, authenticated;
GRANT ALL ON public.credit_months TO service_role;

COMMIT;

-- VERDICT. Expect: rows = 0, no_browser_access = true.
SELECT
  (SELECT count(*) FROM public.credit_months) AS rows,
  NOT has_table_privilege('authenticated', 'public.credit_months', 'SELECT') AS no_browser_access;
