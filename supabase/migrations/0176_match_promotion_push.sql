-- 0176 — a push is its own row. A match has many; a channel has many.
--
-- ══ WHY A TABLE AND NOT MORE COLUMNS ═════════════════════════════════════════════════════════
-- 0128 made match_promotion_plan one row per match: six booleans, ONE push_at, ONE promo_code.
--
-- Teresa: "As of now we can pick the channels, and only 1 date for the pushes. Same thing with the
-- code. Only one code, but eventually, we could have multiple codes (for different channels for
-- example) ... Pick the channel. Pick the date or dates when we are doing the push in that channel.
-- Mention if this channel will have a code or not. And for each date, leave a small field to add
-- the topic of the push as it might vary between days."
--
-- "Many dates per channel, each with its own topic" has no column shape. The parent keeps what is
-- genuinely per-match (the comment, who last touched it); everything that describes a SEND moves
-- down here.
--
-- ══ "THIS CHANNEL IS ON" IS NOW "THIS CHANNEL HAS A ROW" ═════════════════════════════════════
-- There is no boolean left to carry it, so a channel that is chosen with no date settled is a row
-- with push_at NULL. That is 0128's state, preserved deliberately and now per channel rather than
-- per match: an amber "needs a date", not an absent row. It costs a row, which is the price of
-- being able to say "WhatsApp is happening, we have not picked when" at all.
--
-- ══ THE CODE IS PER CHANNEL, THE COLUMN IS PER PUSH ══════════════════════════════════════════
-- promo_code sits on the push because that is where a code could eventually differ. The editor
-- shows ONE field per channel and writes the same value to every row of that channel. The table
-- permits two pushes in one channel to disagree; nothing in the UI can produce that.

CREATE TABLE IF NOT EXISTS public.match_promotion_push (
  id            bigserial PRIMARY KEY,
  match_api_id  bigint      NOT NULL,
  channel       text        NOT NULL,
  -- NULL IS STILL A REAL STATE, and it is the one 0128 insisted on: the channel is chosen and the
  -- send time is not settled. An amber "needs a date", not an absent row.
  push_at       timestamptz,
  topic         text,
  promo_code    text,
  pushed_at     timestamptz,
  pushed_by     text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_promotion_push_channel_ck
    CHECK (channel IN ('wa','match_chat','fb','dm','klaviyo_email','klaviyo_sms'))
);

-- The worklist is "the week's pushes ordered by push_at", and it is now over THIS table.
-- Partial, for the same reason 0128's was: a NULL push_at is never in a worklist by definition.
CREATE INDEX IF NOT EXISTS match_promotion_push_at_idx
  ON public.match_promotion_push (push_at) WHERE push_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_promotion_push_match_idx
  ON public.match_promotion_push (match_api_id);

REVOKE ALL ON public.match_promotion_push FROM anon, authenticated;
GRANT ALL ON public.match_promotion_push TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.match_promotion_push_id_seq TO service_role;

-- ── THE AUDIT ALLOWLIST HAS TO BE WIDENED, AGAIN ──────────────────────────────────────────────
-- THIRD TIME. fin_change_log.table_name carries a CHECK allowlist; 0128 widened it for
-- match_promotion_plan and 0130 for fin_venue_fields, and match_promotion_push is not on it. The
-- failure would be loud but total: every push would write and then fail at the audit step.
--
-- Re-declaring cannot fail on an existing row. Read back 2026-09-14, the DISTINCT table_name
-- values actually present in fin_change_log are exactly the seven below, with no stray.
ALTER TABLE public.fin_change_log
  DROP CONSTRAINT IF EXISTS fin_change_log_table_name_check;

ALTER TABLE public.fin_change_log
  ADD CONSTRAINT fin_change_log_table_name_check
  CHECK (table_name IN (
    'fin_expenses',
    'fin_revenue',
    'fin_schedule',
    'fin_venue_cost_overrides',
    'fin_venues',
    'match_promotion_plan',
    'fin_venue_fields',
    'match_promotion_push'
  ));

-- ── THE BACKFILL ──────────────────────────────────────────────────────────────────────────────
-- One row per (match, selected channel), carrying the single push_at, promo_code, pushed_at and
-- pushed_by the parent had. A channel that is false produces no row, which is what "off" means
-- here. A parent with every channel false produces nothing at all, which is "no plan".
--
-- IDEMPOTENT BY GUARD, not by ON CONFLICT: there is no natural key to conflict on, because
-- (match, channel) is legitimately many rows after today. Running this twice with the guard
-- removed would double every plan on the board.
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
  AND NOT EXISTS (SELECT 1 FROM public.match_promotion_push);

COMMENT ON TABLE public.match_promotion_push IS
  'One row per push: a channel, a time, a topic, a code. A match has many and a channel has many. '
  'push_at NULL means the channel is chosen and the time is not settled (0128''s state, now per '
  'channel). Superseded on match_promotion_plan: wa, match_chat, fb, dm, klaviyo_email, '
  'klaviyo_sms, push_at, promo_code, pushed_at, pushed_by — inert after 0176, dropped by a later '
  'migration once this has run for a few days.';
COMMENT ON COLUMN public.match_promotion_push.topic IS
  'What this push is about. Per date, because it varies between dates on the same channel.';
COMMENT ON COLUMN public.match_promotion_push.pushed_at IS
  'When somebody marked THIS push sent. Overdue is push_at < now AND pushed_at IS NULL, per push, '
  'so marking one push of a match leaves the others overdue.';
