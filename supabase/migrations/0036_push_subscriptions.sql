-- ============================================================
-- push_subscriptions — Web Push endpoints per admin user
-- ============================================================
-- One row per (admin, browser/device) pair. A single user typically
-- has multiple endpoints (laptop Chrome, iPhone PWA standalone, iPad
-- PWA standalone). All endpoints receive each notification so
-- whichever surface the operator is on lights up.
--
-- endpoint / p256dh / auth come straight from the browser's
-- PushSubscription.toJSON() shape. The web-push library on the
-- server consumes them verbatim.
--
-- last_seen_at is bumped on every successful re-subscribe (UI calls
-- /api/push/subscribe whenever it confirms the subscription on a
-- visit). Useful for spotting stale subscriptions later.
--
-- 410 Gone / 404 Not Found responses from the push service trigger
-- a row delete from the application code (src/lib/webPush.ts).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id      uuid          NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  endpoint     text          NOT NULL,
  p256dh       text          NOT NULL,
  auth         text          NOT NULL,
  user_agent   text,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  last_seen_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions(user_id);

-- ============================================================
-- RLS — admin can SELECT only their own rows
-- ============================================================
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_admin_self ON push_subscriptions;
CREATE POLICY push_subscriptions_admin_self
  ON push_subscriptions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
        AND app_users.id = push_subscriptions.user_id
    )
  );
-- No INSERT/UPDATE/DELETE policy. Writes go through the service role
-- via /api/push/subscribe and /api/push/unsubscribe. Service-role
-- writes bypass RLS.
