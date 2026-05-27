-- Insert-on-change snapshot of the highest active-membership price
-- per city. Backs the Slate Review "Membership price changes" view.
--
-- One row per detected change event per city, NOT one row per cron
-- run. The nightly job (refreshMembershipPriceSnapshots) computes
-- MAX(price) for ACTIVE subscriptions GROUP BY city, compares each
-- city's current MAX against its most recent snapshot, and INSERTs
-- only when the value changed. First run per city writes a baseline.
--
-- `city` stores the cockpit display name ('Austin', 'Houston'),
-- translated from mdapi_subscriptions.city_identifier (the 3-letter
-- abbr 'ATX'/'HOU') via cityFromAbbr at write time. Cities the
-- cityFromAbbr helper doesn't recognize are skipped (matches the
-- existing membershipSnapshots behavior).
--
-- `stripe_price_id` is nullable and intentionally unpopulated today
-- — the MatchDay API's /admin/subscriptions endpoint doesn't expose
-- Stripe identifiers, so we have nothing to write here. Kept on the
-- schema for forward-compat in case a future sync path adds it (e.g.
-- direct Stripe API enrichment).
--
-- History before the first cron run is GONE — there's no audit log
-- to backfill from. The earliest captured_at per city is the
-- baseline; UI treats a city with only its baseline row as "no
-- changes recorded since {baseline_date}".
--
-- RLS: authenticated read+write, same shape as the other internal-
-- only finance tables.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS membership_price_snapshots (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at            timestamptz   NOT NULL DEFAULT now(),
  city                   text          NOT NULL,
  max_price_dollars      numeric(10,2) NOT NULL,
  active_count_at_price  integer       NOT NULL,
  stripe_price_id        text
);

-- Latest-per-city lookups (UI: "give me the most recent snapshot
-- for Austin"; sync: "what's the latest captured value to compare
-- the current MAX against"). DESC on captured_at so a simple
-- ORDER BY ... LIMIT 1 hits the index directly.
CREATE INDEX IF NOT EXISTS membership_price_snapshots_city_captured_idx
  ON membership_price_snapshots(city, captured_at DESC);

ALTER TABLE membership_price_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membership_price_snapshots_auth ON membership_price_snapshots;
CREATE POLICY membership_price_snapshots_auth
  ON membership_price_snapshots FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
