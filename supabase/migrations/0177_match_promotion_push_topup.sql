-- 0177 — the plans that were saved while 0176 was landing.
--
-- ══ WHAT HAPPENED, MEASURED ══════════════════════════════════════════════════════════════════
-- 0176's backfill ran at 2026-09-14 20:29 UTC and produced 28 push rows. Between 20:33 and 20:48,
-- while the new code was still unpushed, social@playmatchday.com saved NINE more plans through the
-- old editor — which writes match_promotion_plan and knows nothing about match_promotion_push:
--
--   19288 wa · 18703 wa · 18635 wa,dm · 18683 wa,dm · 18600 wa,dm · 18592 wa,dm
--   18618 wa · 18640 wa · 18630 dm
--
-- Thirteen channel selections with no push row. The moment the new code deploys, a plan with no
-- push rows reads as NO PLAN — so those nine matches would have silently emptied off the board,
-- and the person who planned them would have had no way to tell that from never having done it.
--
-- THIS IS THE MIGRATION RACE, and it is not closed by being more careful next time: any plan saved
-- between a backfill and its deploy lands in the same hole.
--
-- ══ SO THIS ONE IS IDEMPOTENT PER MATCH, NOT GLOBALLY ════════════════════════════════════════
-- 0176 guarded on "the push table is empty", which is right exactly once and useless afterwards.
-- This guards per match, so it can be run BEFORE the deploy, AFTER it, and again tomorrow, and
-- each run picks up only what is genuinely missing. Run it again once the deployment is Ready —
-- that is what closes the window rather than narrowing it.
--
-- IT CANNOT TOUCH A MATCH THAT HAS ALREADY MOVED. A match with even one push row is left entirely
-- alone, so a plan someone has since edited under the new code is never reverted to its old shape.

INSERT INTO public.match_promotion_push
  (match_api_id, channel, push_at, promo_code, pushed_at, pushed_by, updated_by, updated_at)
SELECT p.match_api_id, c.channel, p.push_at, p.promo_code, p.pushed_at, p.pushed_by,
       p.updated_by, p.updated_at
FROM public.match_promotion_plan p
CROSS JOIN LATERAL (VALUES
  ('wa', p.wa), ('match_chat', p.match_chat), ('fb', p.fb), ('dm', p.dm),
  ('klaviyo_email', p.klaviyo_email), ('klaviyo_sms', p.klaviyo_sms)
) AS c(channel, selected)
WHERE c.selected
  AND NOT EXISTS (
    SELECT 1 FROM public.match_promotion_push x
    WHERE x.match_api_id = p.match_api_id
  );

-- What it did. Expected 13 rows across 9 matches on the first run, and 0 on every run after that
-- until somebody saves through the old editor again.
SELECT count(*) AS push_rows,
       count(DISTINCT match_api_id) AS matches,
       count(*) FILTER (WHERE push_at IS NULL) AS needs_a_date
FROM public.match_promotion_push;
