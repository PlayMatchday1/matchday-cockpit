-- ============================================================
-- firstmatch_ledger — first-match promo abuse ledger
-- ============================================================
-- Purpose: catch players who delete + remake accounts to re-claim
-- the free first match. One row per firstmatch claim (a
-- mdapi_match_players registration with is_first_match = true),
-- captured at sync time while the account is still active.
--
-- Why a standalone table (no FK to mdapi_*): mdapi_match_players and
-- mdapi_users are mutable mirrors — re-synced last-write-wins, and
-- scrubbed to del_<hash>@playmatchday.com / null phone when a user
-- deletes their account. The whole point of this ledger is to OUTLIVE
-- that scrub: it holds a permanent one-way hash captured before the
-- account was deleted. So it deliberately does NOT reference the
-- mirror tables; player_api_id / user_id / match_api_id are stored as
-- plain bigints (the MatchDay API ids) for traceability only.
--
-- Identity columns:
--   * display_name — stored readable (for human review).
--   * phone_hash / email_hash — HMAC-SHA256 hex, computed app-side in
--     scripts/lib using the FIRSTMATCH_LEDGER_SALT env secret (NOT in
--     code, NOT in this SQL). The same phone/email always hashes the
--     same so cross-account reuse is detectable. NULL when the value
--     was missing or already scrubbed at capture time.
--   * is_unrecoverable — true for claims whose account was already
--     deleted/scrubbed before we could hash real values (the ~17%
--     del_-email / null-phone rows at backfill time). Kept as explicit
--     markers (not dropped, not fake hashes) so the known-blind set
--     stays visible. These rows never participate in cluster matching
--     (their hashes are NULL).
--
-- Scope: is_first_match = true ONLY. promocode_id is intentionally
-- ignored — investigation showed promocode_id is null on most claims
-- and split across three 'firstmatch' catalog records, so it misses
-- the population. Cancelled claims ARE included (is_cancelled flag
-- carried through so the review view can filter them).
--
-- Writes: backfill script + daily cron step, both via the service
-- role (bypasses RLS). No operator writes directly.
--
-- RLS: corp admin SELECT only — same gate as the rest of the Admin
-- section (crm_threads / crm_canned_responses): app_users.is_admin
-- matched on the JWT email. Shows player names + abuse patterns, so it
-- is NOT exposed to the broad `authenticated` role like mdapi_users.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.
-- Set FIRSTMATCH_LEDGER_SALT in Vercel env BEFORE running the backfill
-- or the cron sync step — hashing is inert without it.
-- ============================================================

CREATE TABLE IF NOT EXISTS firstmatch_ledger (
  -- Natural PK = the registration id (mdapi_match_players.api_id).
  -- One ledger row per claim; backfill + cron upsert on this column.
  player_api_id     bigint        PRIMARY KEY,

  -- MatchDay user id. Counts DISTINCT accounts behind a shared hash —
  -- the core abuse signal (same phone/email, >= 2 user_ids).
  user_id           bigint        NOT NULL,

  -- Readable name for human review.
  display_name      text,

  -- One-way HMAC-SHA256 hex (app-side, salted). NULL = missing or
  -- already scrubbed at capture.
  phone_hash        text,
  email_hash        text,

  -- The claim moment: mdapi_match_players.created_at.
  claim_date        timestamptz   NOT NULL,

  -- Where the claim happened (city abbr from the match) + which match.
  city_identifier   text,
  match_api_id      bigint,

  -- Carried through so the review view can filter cancelled claims.
  is_cancelled      boolean       NOT NULL DEFAULT false,

  -- true = real phone/email gone before we could hash. Marker only;
  -- never clusters (hashes are NULL).
  is_unrecoverable  boolean       NOT NULL DEFAULT false,

  -- Provenance of the row.
  source            text          NOT NULL CHECK (source IN ('backfill', 'sync')),

  -- Ledger bookkeeping. created_at = first insert; synced_at = last
  -- idempotent touch (e.g. is_cancelled flips after a later sync).
  created_at        timestamptz   NOT NULL DEFAULT now(),
  synced_at         timestamptz   NOT NULL DEFAULT now()
);

-- Hash lookups for cluster detection. Partial (non-null) — scrubbed /
-- unrecoverable rows carry NULL hashes and must not group together.
CREATE INDEX IF NOT EXISTS firstmatch_ledger_phone_hash_idx
  ON firstmatch_ledger(phone_hash) WHERE phone_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS firstmatch_ledger_email_hash_idx
  ON firstmatch_ledger(email_hash) WHERE email_hash IS NOT NULL;

-- claim_date desc: drives the full-ledger table view (newest first).
CREATE INDEX IF NOT EXISTS firstmatch_ledger_claim_date_idx
  ON firstmatch_ledger(claim_date DESC);

-- user_id + city: distinct-account counting and city filtering.
CREATE INDEX IF NOT EXISTS firstmatch_ledger_user_id_idx
  ON firstmatch_ledger(user_id);

CREATE INDEX IF NOT EXISTS firstmatch_ledger_city_idx
  ON firstmatch_ledger(city_identifier);

-- ============================================================
-- RLS — corp admin SELECT only (same gate as the Admin section)
-- ============================================================
-- Reads happen through service-role API routes, but this policy is
-- defense in depth if a caller ever hits the table with a user JWT
-- directly. Matches the crm_threads / crm_canned_responses idiom:
-- app_users.is_admin = true, joined on the JWT email claim.
-- No INSERT/UPDATE/DELETE policy: backfill + cron write via the
-- service role, which bypasses RLS.
ALTER TABLE firstmatch_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firstmatch_ledger_admin_select ON firstmatch_ledger;
CREATE POLICY firstmatch_ledger_admin_select
  ON firstmatch_ledger FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );

-- ============================================================
-- fin_sync_log.source — allow the cron step to log itself
-- ============================================================
-- Same drop/recreate pattern as migrations 0020, 0023, 0052. Adds
-- 'firstmatch-ledger' while preserving every existing source.
ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'mdapi-promocodes',
    'mdapi-matches',
    'mdapi-users',
    'mdapi-users-lens-snapshot',
    'membership-snapshots',
    'membership-prices',
    'manager-pay-recompute',
    'firstmatch-ledger'
  ));
