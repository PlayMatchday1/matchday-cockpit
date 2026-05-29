-- ============================================================
-- crm_unread_count(p_user_id) — single-query unread customer-chat
-- count for the "Chats" nav badge
-- ============================================================
-- Collapses the nav-badge count into ONE indexed round-trip (the badge
-- polls every 30s per open admin, so the previous 50-HTTP-round-trip
-- fan-out from computeUnreadCountsForUsers was too chatty to poll).
--
-- !!! PAIRED DEFINITION — MUST STAY IN SYNC !!!
-- This function MUST mirror the unread rule in
-- src/lib/crmPushNotify.ts → computeUnreadCountsForUsers (the same rule
-- the iOS PWA home-screen badge uses). If you change one, change both,
-- or the nav badge and the PWA badge will disagree. The rule:
--   1. Consider the 50 most-recent threads (ORDER BY last_message_at DESC).
--   2. A thread counts as unread for the viewer when ALL hold:
--        - last_message_preview IS NOT NULL
--        - the thread's latest message (by sent_at) is direction = 'inbound'
--        - effective last_read_at is older than last_message_at, where:
--            assigned_to_user_id IS NULL  → effective = MAX(last_read_at)
--                                            across all admins
--            assigned_to_user_id = viewer → effective = the viewer's row
--            assigned_to_user_id = other  → never unread (excluded)
--          (NULL effective ⇒ unread)
--   3. Badge total = count of such threads. Channels sms + whatsapp are
--      both included (no channel filter), matching the JS rule.
--
-- Cost: top-50 uses crm_threads(last_message_at DESC); per-thread latest
-- direction uses crm_messages(thread_id, sent_at DESC); read lookups use
-- crm_thread_reads PK (thread_id, user_id). No full-table scan.
--
-- Security: callable only by service_role. The GET
-- /api/crm/threads/unread-count route (admin-gated via crmAuth) calls it
-- with the session-derived viewer id, so p_user_id is never client-
-- controlled. EXECUTE is revoked from anon/authenticated so the count
-- can't be probed directly with an arbitrary user id.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.
-- ============================================================

CREATE OR REPLACE FUNCTION crm_unread_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  WITH recent AS (
    SELECT
      t.id,
      t.last_message_at,
      t.last_message_preview,
      t.assigned_to_user_id,
      (
        SELECT m.direction
        FROM crm_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.sent_at DESC
        LIMIT 1
      ) AS last_direction
    FROM crm_threads t
    ORDER BY t.last_message_at DESC
    LIMIT 50
  )
  SELECT count(*)::int
  FROM recent r
  WHERE r.last_message_preview IS NOT NULL
    AND r.last_direction = 'inbound'
    AND (
      CASE
        WHEN r.assigned_to_user_id IS NULL THEN
          r.last_message_at > COALESCE(
            (SELECT max(tr.last_read_at)
               FROM crm_thread_reads tr
              WHERE tr.thread_id = r.id),
            '-infinity'::timestamptz
          )
        WHEN r.assigned_to_user_id = p_user_id THEN
          r.last_message_at > COALESCE(
            (SELECT tr.last_read_at
               FROM crm_thread_reads tr
              WHERE tr.thread_id = r.id
                AND tr.user_id = p_user_id),
            '-infinity'::timestamptz
          )
        ELSE
          false
      END
    );
$$;

-- Lock down execution: route uses the service role; no direct
-- anon/authenticated calls with an arbitrary p_user_id.
REVOKE ALL ON FUNCTION crm_unread_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_unread_count(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION crm_unread_count(uuid) TO service_role;
