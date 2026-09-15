-- 0178 — the channels ADDED to a plan while 0176 was landing. RUN ONCE, BEFORE THE DEPLOY.
--
-- ══ THE THIRD SHAPE OF THE SAME RACE ═════════════════════════════════════════════════════════
-- 0176 backfilled at 20:29 UTC. 0177 caught the nine plans CREATED after that, guarded per match.
-- This catches the fourth thing: channels added to a plan that ALREADY had push rows, which 0177
-- deliberately will not touch. Measured 2026-09-15 01:06 UTC, five selections on four matches:
--
--   18604  parent updated 20:43  says wa, match_chat, klaviyo_sms  ·  has klaviyo_sms
--   19281  parent updated 20:43  says wa, fb, dm, klaviyo_sms      ·  has wa, dm, klaviyo_sms
--   18686  parent updated 20:44  says wa, dm                       ·  has wa
--   18663  parent updated 20:44  says wa, dm                       ·  has wa
--
-- Every one edited by social@playmatchday.com through the old editor, after the backfill had run.
--
-- ══ WHY THIS MUST NEVER RUN AFTER THE DEPLOY ═════════════════════════════════════════════════
-- RIGHT NOW the parent's six booleans are the ONLY record of which channels are chosen, so filling
-- a gap from them is simply repair. FROM THE DEPLOY ONWARD they are inert and never updated again,
-- so "the parent says wa and there is no wa push row" stops meaning "a row is missing" and starts
-- meaning "somebody turned WhatsApp off". Run this a week from now and it resurrects every channel
-- anybody has ever switched off, permanently, with no way to switch them off again.
--
-- SO IT CARRIES A HARD CUTOFF rather than a warning. 01:06:30Z is the moment the five gaps were
-- measured; a parent touched after it is excluded, and the new code bumps updated_at on every save,
-- so every edit made under it is immune by construction. Re-running this changes nothing.

INSERT INTO public.match_promotion_push
  (match_api_id, channel, push_at, promo_code, pushed_at, pushed_by, updated_by, updated_at)
SELECT p.match_api_id, c.channel, p.push_at, p.promo_code, NULL, NULL,
       p.updated_by, p.updated_at
FROM public.match_promotion_plan p
CROSS JOIN LATERAL (VALUES
  ('wa', p.wa), ('match_chat', p.match_chat), ('fb', p.fb), ('dm', p.dm),
  ('klaviyo_email', p.klaviyo_email), ('klaviyo_sms', p.klaviyo_sms)
) AS c(channel, selected)
WHERE c.selected
  -- THE CUTOFF. Not a comment, a predicate: nothing edited after the gaps were measured.
  AND p.updated_at < TIMESTAMPTZ '2026-09-15 01:06:30+00'
  AND NOT EXISTS (
    SELECT 1 FROM public.match_promotion_push x
    WHERE x.match_api_id = p.match_api_id AND x.channel = c.channel
  );

-- pushed_at/pushed_by are NULL above, deliberately: a channel that was added minutes ago has not
-- been sent, and inheriting the parent's stamp would mark a brand new push as already done.

-- Expected: 41 -> 46 rows, 26 matches, 2 still needing a date. 0 on every run after.
SELECT count(*) AS push_rows,
       count(DISTINCT match_api_id) AS matches,
       count(*) FILTER (WHERE push_at IS NULL) AS needs_a_date
FROM public.match_promotion_push;
