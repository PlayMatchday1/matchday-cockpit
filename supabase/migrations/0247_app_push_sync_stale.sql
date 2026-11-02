-- 0247 SYNC WATCHDOG PUSH (Ryan, 2026-11-02). A third staff app push event, sync_stale: the hourly
-- sync watchdog (src/lib/syncWatchdog.ts) pushes Ryan once a day when any data sync has had no clean
-- run in 2 days. Logged in app_push_log like every push; an admin kill switch row like the others.
-- Until this is applied the watchdog reports stale syncs and sends nothing (it checks for the switch row).

ALTER TABLE public.app_push_log DROP CONSTRAINT IF EXISTS app_push_log_event_check;
ALTER TABLE public.app_push_log ADD CONSTRAINT app_push_log_event_check
  CHECK (event IN ('player_chat', 'match_at_risk', 'sync_stale'));

ALTER TABLE public.app_push_switches DROP CONSTRAINT IF EXISTS app_push_switches_event_check;
ALTER TABLE public.app_push_switches ADD CONSTRAINT app_push_switches_event_check
  CHECK (event IN ('player_chat', 'match_at_risk', 'sync_stale'));

INSERT INTO public.app_push_switches (event, enabled, updated_by)
VALUES ('sync_stale', true, 'migration 0247')
ON CONFLICT (event) DO NOTHING;
