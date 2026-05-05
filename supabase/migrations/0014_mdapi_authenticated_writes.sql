-- Phase 2 — manual sync UI needs the session client (authenticated
-- user, not service role) to upsert rows into mdapi_reviews and
-- mdapi_subscriptions. The original migrations granted only SELECT
-- to authenticated; this adds INSERT + UPDATE to support upsert
-- from the /api/sync/reviews and /api/sync/subscriptions endpoints.
--
-- Pattern mirrors fin_sync_log (migration 0009) — permissive
-- WITH CHECK (true) since the API route layer already validates
-- the caller has finance/data permission. RLS is the second line
-- of defense (auth must succeed first).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- === mdapi_reviews ===

DROP POLICY IF EXISTS mdapi_reviews_auth_insert ON mdapi_reviews;
CREATE POLICY mdapi_reviews_auth_insert
  ON mdapi_reviews FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS mdapi_reviews_auth_update ON mdapi_reviews;
CREATE POLICY mdapi_reviews_auth_update
  ON mdapi_reviews FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- === mdapi_subscriptions ===

DROP POLICY IF EXISTS mdapi_subscriptions_auth_insert ON mdapi_subscriptions;
CREATE POLICY mdapi_subscriptions_auth_insert
  ON mdapi_subscriptions FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS mdapi_subscriptions_auth_update ON mdapi_subscriptions;
CREATE POLICY mdapi_subscriptions_auth_update
  ON mdapi_subscriptions FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
