-- 0271: App push becomes a Match Promotion channel (2026-11-12).
--
-- match_promotion_push.channel is a CHECK list (0176). This adds 'app_push', a push notification to
-- the MatchDay app. Like the other six it is planned in Clubhouse and sent by staff, who then mark it
-- sent; nothing here sends it. Only the list widens, so every existing row still passes.

BEGIN;

ALTER TABLE public.match_promotion_push
  DROP CONSTRAINT IF EXISTS match_promotion_push_channel_ck;

ALTER TABLE public.match_promotion_push
  ADD CONSTRAINT match_promotion_push_channel_ck
  CHECK (channel IN ('wa','match_chat','fb','dm','klaviyo_email','klaviyo_sms','app_push'));

COMMIT;
