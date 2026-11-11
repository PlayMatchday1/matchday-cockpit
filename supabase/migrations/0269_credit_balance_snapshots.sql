-- 0269 — Credits: one row a day of the players' outstanding credit balance (Ryan, 2026-11-10).
--
-- WHY. The app never records a credit and nothing saved the balance over time, so the monthly credits report had no
-- month-end balance for Oct 31. This table keeps one row per Central day, written by the Clubhouse sync
-- (/api/sync/credit-balance-snapshot, source 'credit-balance-snapshot' in fin_sync_log) right after the 3 AM Central
-- player pass has re-read every player into mdapi_users.
--
-- WHAT IS COUNTED. mdapi_users.raw->creditAmount, in cents: the wallet in the currency of the player's preferable city
-- (creditAmountFromPreferableCity, backend users/utils/user-credits.ts), so a credit held in another currency's wallet
-- reads 0 here. Left out: @matchday.com (test) and @playmatchday.com (staff) addresses, deleted accounts (first and
-- last name "Deleted" "Account", the scrub), fake players, and Warsaw (PLN).
--   outstanding_cents       sum of balances above zero
--   players_with_balance    players whose balance is above zero
--   negative_count / _cents players below zero, and the sum of those balances (zero or less)
--   players_read            every mdapi_users row read, before the exclusions
--   mirror_oldest_synced_at the oldest synced_at among the counted players with a balance: how stale the oldest
--                           balance in the total is
--   player_pass_finished_at when the night's full player pass finished (player_area_sync_runs), null if it had not
--
-- MONTH-END. The row taken on the 1st of a month by the night run is the balance at the end of the month before.

BEGIN;

CREATE TABLE IF NOT EXISTS public.credit_balance_snapshots (
  day                      date        PRIMARY KEY,         -- Central date the snapshot was taken
  taken_at                 timestamptz NOT NULL DEFAULT now(),
  triggered_by             text        NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  outstanding_cents        bigint      NOT NULL,
  players_with_balance     integer     NOT NULL,
  negative_count           integer     NOT NULL,
  negative_cents           bigint      NOT NULL CHECK (negative_cents <= 0),
  players_read             integer     NOT NULL,
  mirror_oldest_synced_at  timestamptz,
  player_pass_finished_at  timestamptz
);

ALTER TABLE public.credit_balance_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_balance_snapshots FROM anon, authenticated;
GRANT ALL ON public.credit_balance_snapshots TO service_role;

-- fin_sync_log.source is a CHECK allowlist: an unknown source makes the log insert fail silently.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conname = 'fin_sync_log_source_check' AND conrelid = 'public.fin_sync_log'::regclass;
  IF d IS NULL THEN RAISE EXCEPTION 'fin_sync_log_source_check not found'; END IF;
  IF d NOT LIKE '%''credit-balance-snapshot''%' THEN
    d := replace(d, ']))', ', ''credit-balance-snapshot''::text]))');
    IF d NOT LIKE '%''credit-balance-snapshot''%' THEN RAISE EXCEPTION 'unexpected constraint shape: %', d; END IF;
    EXECUTE 'ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check';
    EXECUTE 'ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check ' || d;
  END IF;
END $$;

COMMIT;

-- VERDICT. Expect: rows = 0, source_ok = true, kept_churn = true (0264's source survived), no_browser_access = true.
SELECT
  (SELECT count(*) FROM public.credit_balance_snapshots) AS rows,
  (SELECT pg_get_constraintdef(oid) LIKE '%''credit-balance-snapshot''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS source_ok,
  (SELECT pg_get_constraintdef(oid) LIKE '%''churn-player-field''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS kept_churn,
  NOT has_table_privilege('authenticated', 'public.credit_balance_snapshots', 'SELECT') AS no_browser_access;
