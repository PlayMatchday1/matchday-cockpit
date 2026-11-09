-- 0266 — Former staff: a per-player flag that keeps a person off the Churn list (Ryan, 2026-11-09).
--
-- WHY. Former MatchDay employees played (and managed) on free or $1 plans; on Churn they read as the heaviest
-- players who stopped, which is not a win-back. Carlos (user 1114) is the first. The flag is set and cleared from
-- Player Lookup, by staff holding MANAGE PLAYERS (read fresh per request, as every Clubhouse write is), and Churn
-- leaves flagged people out. One row per PERSON (growth_person_link's person id), so every account of theirs is out.
-- Clearing keeps the row with former_staff = false, so who set and who cleared stay visible.

BEGIN;

CREATE TABLE IF NOT EXISTS public.player_former_staff (
  person_id     bigint      PRIMARY KEY,
  former_staff  boolean     NOT NULL DEFAULT true,
  note          text,
  set_by        text        NOT NULL,      -- staff email of the last change
  set_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.player_former_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_former_staff FROM anon, authenticated;
GRANT ALL ON public.player_former_staff TO service_role;

COMMIT;

-- VERDICT. Expect: rows = 0, no_browser_access = true.
SELECT
  (SELECT count(*) FROM public.player_former_staff) AS rows,
  NOT has_table_privilege('authenticated', 'public.player_former_staff', 'SELECT') AS no_browser_access;
