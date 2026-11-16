-- 0273: A SYNC-LOG SOURCE FOR THE 15-MINUTE CURRENT-MEMBERS SYNC (Ryan, 2026-11-16).
--
-- Apply via Supabase Dashboard, SQL Editor. One transaction. Changes one CHECK constraint only.
--
-- WHY. The Members page gets a second subscriptions sync every 15 minutes that reads only current
-- members (ACTIVE and PAST_DUE). It logs under its own source, mdapi-subscriptions-current, so its
-- clean runs can never hide a failing nightly full sync (the watchdog judges each source by its own
-- last clean run). A source missing from this allowlist makes the log insert fail silently
-- (runWithLog returns ok:false without throwing), so the constraint lands before the code.
--
-- The live definition is read and the new source appended, so no source added since is dropped by
-- retyping the list (the 0236 pattern).

BEGIN;

DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conname = 'fin_sync_log_source_check' AND conrelid = 'public.fin_sync_log'::regclass;
  IF d IS NULL THEN RAISE EXCEPTION 'fin_sync_log_source_check not found'; END IF;
  IF d NOT LIKE '%mdapi-subscriptions-current%' THEN
    d := replace(d, ']))', ', ''mdapi-subscriptions-current''::text]))');
    IF d NOT LIKE '%mdapi-subscriptions-current%' THEN RAISE EXCEPTION 'unexpected constraint shape: %', d; END IF;
    EXECUTE 'ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check';
    EXECUTE 'ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check ' || d;
  END IF;
END $$;

COMMIT;

-- READ-BACK. Expect sources_ok = true.
SELECT pg_get_constraintdef(oid) LIKE '%mdapi-subscriptions-current%' AS sources_ok
  FROM pg_constraint WHERE conname = 'fin_sync_log_source_check';
