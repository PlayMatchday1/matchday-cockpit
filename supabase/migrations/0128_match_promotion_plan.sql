-- MATCH PROMOTION PLAN — one row per match, holding what marketing will do for it.
--
-- WHAT THIS IS. Clubhouse's own record of which matches get promoted, on which channels, and when
-- the push goes out. It touches the MatchDay API not at all and mdapi_matches not at all: the
-- mirror is read-only and this table joins to it by api_id WITHOUT a foreign key, exactly as
-- veo_intent does (0100). A mirror row can be re-synced or deleted under us; an FK would turn that
-- into a failed cron.
--
-- SIX BOOLEANS, NOT AN ARRAY. A channel can be added later as one more column with a default,
-- which is an ALTER, not a data migration. And "what is going out on WhatsApp this week" stays a
-- plain indexable predicate rather than an array containment scan.
--
-- push_at NULL IS A REAL STATE, NOT AN ABSENCE. It means the channels are chosen and the send time
-- is not settled yet — the amber "needs a decision" tile, and what the orange CHECK rows in the
-- spreadsheet have always meant. A row with every boolean false and push_at NULL is "no plan";
-- the two are told apart by the booleans, never by the presence of the row.
CREATE TABLE IF NOT EXISTS public.match_promotion_plan (
  match_api_id  bigint PRIMARY KEY,
  wa            boolean     NOT NULL DEFAULT false,
  match_chat    boolean     NOT NULL DEFAULT false,
  fb            boolean     NOT NULL DEFAULT false,
  dm            boolean     NOT NULL DEFAULT false,
  klaviyo_email boolean     NOT NULL DEFAULT false,
  klaviyo_sms   boolean     NOT NULL DEFAULT false,
  push_at       timestamptz,
  promo_code    text,
  comment       text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The worklist ("next 48 hours", ordered by push_at) is the one query that runs on every page load
-- and is not keyed by the primary key. Partial: a NULL push_at is never in the worklist by
-- definition, so it does not belong in the index.
CREATE INDEX IF NOT EXISTS match_promotion_plan_push_at_idx
  ON public.match_promotion_plan (push_at)
  WHERE push_at IS NOT NULL;

REVOKE ALL ON public.match_promotion_plan FROM anon, authenticated;
GRANT ALL ON public.match_promotion_plan TO service_role;

-- ── THE AUDIT ALLOWLIST HAS TO BE WIDENED FIRST ────────────────────────────────────────────────
-- fin_change_log.table_name carries a CHECK allowlist. It was created outside this migrations
-- folder, so nothing in the repo declares it; the live definition was read back off the database by
-- probing the constraint, which accepted exactly these five values and refused everything else:
--
--   fin_expenses · fin_revenue · fin_schedule · fin_venue_cost_overrides · fin_venues
--
-- Without this widening EVERY promotion write fails at the audit step — loudly, which is the
-- correct failure, but total. This is the same trap the fin_sync_log source allowlist set.
--
-- The five existing values are re-listed verbatim. If the live constraint carries a sixth value
-- this probe could not guess, that value is dropped here — the probe covered every fin_* table
-- referenced anywhere in src/, so a survivor would have to be a table no code has ever written.
ALTER TABLE public.fin_change_log
  DROP CONSTRAINT IF EXISTS fin_change_log_table_name_check;

ALTER TABLE public.fin_change_log
  ADD CONSTRAINT fin_change_log_table_name_check
  CHECK (table_name IN (
    'fin_expenses',
    'fin_revenue',
    'fin_schedule',
    'fin_venue_cost_overrides',
    'fin_venues',
    'match_promotion_plan'
  ));
