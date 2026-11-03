-- 0250 A CITY ON EVERY PLAYER CHATS THREAD (Ryan, 2026-11-02).
--
-- crm_threads had no city, so a thread reached a city only through its assignee (src/lib/crmScope.ts).
-- These two columns replace that rule. city_code is a CITY_SCOPES identifier (ATX, HOU, WAW...);
-- city_source says where it came from, in the order the code tries them:
--   account   the linked player's preferable city
--   field     a field or match named in the conversation, matched against mdapi_matches field names
--   inferred  the draft model's best guess from the text, or the player's answer to "which city?"
--   staff     a person set it from the thread header (logged in change_log)
-- A thread with no city yet is shown to admins only.
--
-- Backfill: every thread linked to a player whose preferable city is set. Measured 2026-11-02:
-- 731 threads, 619 linked, 617 of those with a city. The 3 threads assigned to a confined
-- account are all linked and their player's city equals the assignee's, so dropping the assignee
-- rule hides nothing anyone sees today.
--
-- Locking: two nullable columns (no rewrite), one UPDATE over ~620 rows, one index.
-- Rollback: ALTER TABLE crm_threads DROP COLUMN city_source, DROP COLUMN city_code;

BEGIN;

ALTER TABLE public.crm_threads ADD COLUMN IF NOT EXISTS city_code text;
ALTER TABLE public.crm_threads ADD COLUMN IF NOT EXISTS city_source text;

ALTER TABLE public.crm_threads DROP CONSTRAINT IF EXISTS crm_threads_city_source_check;
ALTER TABLE public.crm_threads ADD CONSTRAINT crm_threads_city_source_check
  CHECK (city_source IS NULL OR city_source IN ('account', 'field', 'inferred', 'staff'));
ALTER TABLE public.crm_threads DROP CONSTRAINT IF EXISTS crm_threads_city_pair_check;
ALTER TABLE public.crm_threads ADD CONSTRAINT crm_threads_city_pair_check
  CHECK ((city_code IS NULL) = (city_source IS NULL));

CREATE INDEX IF NOT EXISTS crm_threads_city_code_idx ON public.crm_threads (city_code);

UPDATE public.crm_threads t
   SET city_code = u.preferable_city_normalized, city_source = 'account'
  FROM public.mdapi_users u
 WHERE t.player_id = u.id
   AND t.city_code IS NULL
   AND u.preferable_city_normalized IS NOT NULL
   AND btrim(u.preferable_city_normalized) <> '';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Check after applying (expect about 617 account rows and about 114 null):
-- SELECT city_source, city_code, count(*) FROM crm_threads GROUP BY 1, 2 ORDER BY 1, 2;
