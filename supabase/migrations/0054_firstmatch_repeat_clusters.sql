-- ============================================================
-- firstmatch_repeat_clusters — abuse review detection view
-- ============================================================
-- Surfaces likely delete-and-remake repeat abuse for HUMAN REVIEW
-- (never an auto-denial). A cluster = one identifier (phone OR email
-- hash) shared across >= 2 DISTINCT user_id, i.e. the same phone/email
-- used by two or more separate MatchDay accounts to claim a first
-- match. phone and email are evaluated independently and UNION'd, so a
-- reviewer can see WHICH identifier matched; an abuser who reused both
-- shows up as two rows (one per match_type) — intentional, it's a
-- stronger signal.
--
-- Either-match (phone OR email), not both: repeat abusers often reuse
-- just one identifier (same phone, new email, or vice versa). Output is
-- human-review, so the extra false positives from shared/recycled
-- numbers cost a glance, not a wrongful denial.
--
-- Each row carries the full entry list as jsonb (name, claim_date,
-- city, is_cancelled, ...) so the UI can render "these N names across
-- these months are the same phone" — the actionable part, not just a
-- count. Cancelled claims are included; is_cancelled is per-entry so
-- the UI can filter/annotate them.
--
-- Rows with NULL hashes (the del_-scrubbed / unrecoverable markers)
-- never cluster — the WHERE clauses exclude them.
--
-- security_invoker = true: the view runs with the QUERYING user's
-- privileges, so the admin-only RLS on firstmatch_ledger applies here
-- too. Without it the view would run as owner and bypass RLS, leaking
-- player names to any authenticated user. This is load-bearing — do
-- not remove it.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.
-- (Run AFTER 0053_firstmatch_ledger.sql.)
-- ============================================================

CREATE OR REPLACE VIEW firstmatch_repeat_clusters
  WITH (security_invoker = true) AS
WITH phone_clusters AS (
  SELECT
    'phone'::text                AS match_type,
    phone_hash                   AS match_hash,
    count(*)                     AS claim_count,
    count(DISTINCT user_id)      AS distinct_accounts,
    min(claim_date)              AS first_claim,
    max(claim_date)              AS last_claim,
    jsonb_agg(
      jsonb_build_object(
        'name',          display_name,
        'claim_date',    claim_date,
        'city',          city_identifier,
        'is_cancelled',  is_cancelled,
        'user_id',       user_id,
        'match_api_id',  match_api_id,
        'player_api_id', player_api_id
      ) ORDER BY claim_date
    )                            AS entries
  FROM firstmatch_ledger
  WHERE phone_hash IS NOT NULL
  GROUP BY phone_hash
  HAVING count(DISTINCT user_id) >= 2
),
email_clusters AS (
  SELECT
    'email'::text                AS match_type,
    email_hash                   AS match_hash,
    count(*)                     AS claim_count,
    count(DISTINCT user_id)      AS distinct_accounts,
    min(claim_date)              AS first_claim,
    max(claim_date)              AS last_claim,
    jsonb_agg(
      jsonb_build_object(
        'name',          display_name,
        'claim_date',    claim_date,
        'city',          city_identifier,
        'is_cancelled',  is_cancelled,
        'user_id',       user_id,
        'match_api_id',  match_api_id,
        'player_api_id', player_api_id
      ) ORDER BY claim_date
    )                            AS entries
  FROM firstmatch_ledger
  WHERE email_hash IS NOT NULL
  GROUP BY email_hash
  HAVING count(DISTINCT user_id) >= 2
)
SELECT * FROM phone_clusters
UNION ALL
SELECT * FROM email_clusters
ORDER BY distinct_accounts DESC, last_claim DESC;

-- Same access posture as the base table: admin-only. RLS on
-- firstmatch_ledger (via security_invoker) governs row visibility, but
-- be explicit about role grants too — authenticated may query (rows
-- still filtered by RLS to admins); anon may not touch it at all.
REVOKE ALL ON firstmatch_repeat_clusters FROM anon;
GRANT SELECT ON firstmatch_repeat_clusters TO authenticated;
