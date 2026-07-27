-- Community invite poster — the SCHEDULE. Separate from 0080 on purpose: run
-- 0080, deploy, dry-run, and only THEN run this to start the every-15-min job.
--
-- We're on Vercel Hobby (crons capped at once/day), so the trigger is Supabase
-- pg_cron + pg_net hitting the shared-secret endpoint. The secret is read from
-- Supabase Vault AT CALL TIME so cron.job.command stores the QUERY, not the
-- secret value (cron.job is readable — never inline the token).
--
-- Apply via Supabase Dashboard → SQL Editor.

-- Extensions (no-ops if already enabled). Vault (supabase_vault) is enabled by
-- default on Supabase.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── STEP A ─ store the secret in Vault ONCE, with the REAL value ────────────
-- Run this by itself, substituting the same value you set for the Vercel env
-- var COMMUNITY_POST_SECRET. Do NOT commit the value anywhere.
--
--   SELECT vault.create_secret(
--     'PASTE_THE_COMMUNITY_POST_SECRET_HERE',
--     'community_post_secret',
--     'Bearer token for POST /api/community/post'
--   );
--
-- To rotate later:
--   SELECT vault.update_secret(
--     (SELECT id FROM vault.secrets WHERE name = 'community_post_secret'),
--     'NEW_SECRET_VALUE'
--   );

-- ── STEP B ─ schedule every 15 minutes ─────────────────────────────────────
-- The Authorization header is built at execution time from Vault, so the
-- stored command text never contains the secret.
SELECT cron.schedule(
  'community-invite-post',
  '*/15 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://matchday-clubhouse.vercel.app/api/community/post',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'community_post_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $job$
);

-- ── To pause / remove the schedule ──────────────────────────────────────────
--   SELECT cron.unschedule('community-invite-post');

-- ── Debugging (pg_net is fire-and-forget — responses land here) ─────────────
-- Recent HTTP responses (status_code, content) from the cron's POSTs:
--   SELECT id, status_code, content, created
--   FROM net._http_response ORDER BY created DESC LIMIT 20;
-- Recent cron run outcomes:
--   SELECT jobid, runid, status, return_message, start_time
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'community-invite-post')
--   ORDER BY start_time DESC LIMIT 20;
