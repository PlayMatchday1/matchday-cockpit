-- 0175 — a push that went out stops being overdue, and says who sent it.
--
-- ══ WHY THERE WAS NOTHING TO RECORD IT ═══════════════════════════════════════════════════════
-- 0128 gave match_promotion_plan the channels, the push time, the promo code and the comment, and
-- nothing that records the SEND HAPPENING. So "overdue" could only ever mean "push_at is in the
-- past", and a push that went out at noon is still red at midnight. Six rows on the strip today
-- are overdue forever.
--
-- Ryan: "we need a way to mark these things complete it should be really simple so you can show
-- them done and not overdue but they still show so everyone has visibility."
--
-- ══ TWO COLUMNS, NOT A BOOLEAN ═══════════════════════════════════════════════════════════════
-- "Done" with no timestamp cannot answer "was it sent before or after kickoff", and with no name
-- cannot answer "who said so" — which is the whole point of leaving the row on the strip for
-- everyone to see rather than hiding it once it is handled.
--
-- pushed_by IS A HUMAN SAYING IT HAPPENED, not the system observing it. It takes the same identity
-- updated_by already takes, through the same route and the same fin_change_log audit.
--
-- ══ WHAT IT DOES NOT DO ══════════════════════════════════════════════════════════════════════
-- Both nullable, nothing backfills, and every existing row starts null — which is "not sent" and is
-- exactly today's behaviour. Applying this changes nothing until somebody presses Mark sent.
--
-- IT MUST NOT BLUR push_at NULL. 0128 is explicit that a NULL push_at means "needs a decision",
-- which is not the same as "no plan". A row with no push time cannot be marked sent at all, and the
-- UI refuses it rather than writing a pushed_at against a push nobody scheduled.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

ALTER TABLE public.match_promotion_plan
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS pushed_by text;

COMMENT ON COLUMN public.match_promotion_plan.pushed_at IS
  'When somebody marked this push as sent. NULL means not sent. Overdue is push_at < now AND '
  'pushed_at IS NULL, so a sent row goes quiet without leaving the strip.';
COMMENT ON COLUMN public.match_promotion_plan.pushed_by IS
  'Who marked it sent, same identity as updated_by. A person asserting it happened, not an '
  'observed delivery receipt from any channel.';
