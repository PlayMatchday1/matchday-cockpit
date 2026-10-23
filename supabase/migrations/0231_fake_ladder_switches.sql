-- 0231 — THE NEW FAKE LADDER: WHEN IT WAS SWITCHED ON, AND WHERE (Ryan, 2026-10-23).
--
-- Apply via Supabase Dashboard → SQL Editor. One transaction. Additive only: one new table.
--
-- WHY. The default ladder changed (src/lib/fakeLadder.ts newDefaultLadder: capacity −2 / −2 / −3 /
-- −2 / capacity at 36h / 24h / 12h / 6h / 3h). Fill rate, auto-cancels and the shown-vs-attended
-- gap are to be compared before and after, which needs the date each city crossed over. A commit
-- date is not that date: the defaults reach NEW matches from the deploy, and EXISTING matches only
-- when someone runs "Apply new ladder" (/match-ops/fake-ladder), city by city.
--
-- ONE ROW PER BULK RUN, plus one 'defaults' row inserted below for the code change itself.
--   kind          'defaults' (new matches get the new ladder from here) | 'bulk' (existing matches)
--   scope_city    a city NAME as the API spells it, or NULL = every city
--   started_at    when the run began; the switch date for that scope
--   finished_at   NULL while running, or if the browser was closed mid-run (the change_log rows,
--                 save_id LIKE 'ladder-<id>-%', one per match, are the exact record of what landed)
--   previewed     the count the operator was shown and confirmed
--   landed / unchanged / skipped / not_landed   the tally at the end
--   stopped_reason  NULL on a clean finish; otherwise why it stopped (the run stops at the first
--                 write that did not land, and never retries)

BEGIN;

CREATE TABLE IF NOT EXISTS public.fake_ladder_switches (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('defaults', 'bulk')),
  env             text        NOT NULL DEFAULT 'production' CHECK (env IN ('production', 'staging')),
  scope_city      text,
  actor_email     text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  previewed       integer,
  landed          integer,
  unchanged       integer,
  skipped         integer,
  not_landed      integer,
  stopped_reason  text,
  ladder          jsonb       NOT NULL DEFAULT '{"36":-2,"24":-2,"12":-3,"6":-2,"3":0}'::jsonb
);

CREATE INDEX IF NOT EXISTS fake_ladder_switches_started_idx ON public.fake_ladder_switches (started_at DESC);

-- Written and read only through the service-role routes. RLS on, no policies.
ALTER TABLE public.fake_ladder_switches ENABLE ROW LEVEL SECURITY;

-- THE CODE CHANGE ITSELF. started_at is the moment this migration runs, which is AFTER the deploy
-- that carries the new defaults — correct it by hand to the deploy time if they differ by much:
--   UPDATE public.fake_ladder_switches SET started_at = '<deploy time>' WHERE kind = 'defaults';
INSERT INTO public.fake_ladder_switches (kind, scope_city, actor_email, finished_at)
VALUES ('defaults', NULL, 'migration 0231', now());

COMMIT;

-- Check (expect 1 row, kind = 'defaults'):
-- SELECT id, kind, started_at FROM public.fake_ladder_switches;
--
-- Revert (only before any bulk run has been recorded):
-- DROP TABLE public.fake_ladder_switches;
