-- 0223 — ONE PAYING-MEMBER RULE IN SQL, matching membershipStats.isPaidExternalMember (2026-10-14).
--
-- Draft for review; NOT APPLIED. Apply via Supabase Dashboard → SQL Editor. One transaction.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────────────────────
-- A subscription makes someone a member only when ALL hold:
--   * the plan's monthly price is at least $15 (1500 cents). This MIRRORS
--     PAID_MEMBER_MIN_PRICE_CENTS in src/lib/membershipStats.ts — the database cannot import it, so
--     scripts/membership-floor-test.ts fails if the two ever differ. It matches the "Paid signup"
--     definition in Jaimee's Stripe churn sheet. $0 comps and legacy $1/month plans are out.
--     `price` is the PLAN price, not the $1 signup promo: since 2026-09-01, 152 activations read
--     $66 and one reads $1, against 78 sub-$2 membership charges in fin_txn for September.
--   * the member email is not internal: INTERNAL_EMAIL_RX, /@matchday\.|@playmatchday\./i.
--     A deleted account's tombstone (del_…@playmatchday.com) matches too, which is right here: a
--     scrubbed subscription can no longer be tied to a paying person.
--   * the checkout completed: status not INCOMPLETE / INCOMPLETE_EXPIRED.
-- Status ACTIVE vs CANCELED is NOT part of the rule. A window reader (member spots) needs the
-- cancelled rows; a "member now" reader adds `status = 'ACTIVE'` itself.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────
--   1. paid_member_subscription — the rule, once.
--   2. fin_member_spots_by_venue_month (0222) — a FREE spot is a member spot only under a paying
--      membership. Everything else in its body is unchanged. Revenue's member shares read it.
--   3. player_finder_mv.is_member — was mdapi_users.is_member, which is true for ANY ACTIVE
--      subscription (2026-10-14: true for all 64 people whose only ACTIVE row is $0 and all 12 on a
--      $1 plan). Now: holds an ACTIVE paying subscription. The Finder's Members filter, its Members
--      count and the per-row flag all read this one column. Columns and their order are unchanged.
--
-- PARTNER PAYOUTS DO NOT READ ANY OF THIS. They classify in TypeScript and are held on the old
-- classification until Ryan approves that change separately.

BEGIN;

-- ── 1. THE RULE ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.paid_member_subscription
WITH (security_invoker = true) AS
SELECT s.*
FROM public.mdapi_subscriptions s
WHERE s.price IS NOT NULL
  AND s.price * 100 >= 1500                                      -- PAID_MEMBER_MIN_PRICE_CENTS
  AND COALESCE(s.member_email, '') !~* '@matchday\.|@playmatchday\.'  -- INTERNAL_EMAIL_RX
  AND upper(COALESCE(s.status, '')) NOT LIKE 'INCOMPLETE%';

REVOKE ALL ON public.paid_member_subscription FROM anon;
GRANT SELECT ON public.paid_member_subscription TO authenticated, service_role;

-- ── 2. MEMBER SPOTS PER VENUE PER MONTH — 0222 with the rule on the subscription ─────────────
CREATE OR REPLACE FUNCTION public.fin_member_spots_by_venue_month(p_from date, p_to date)
RETURNS TABLE (fin_venue_id bigint, city text, month date, member_spots integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  select l.fin_venue_id, v.city,
         date_trunc('month', m.start_date at time zone 'UTC')::date as month,  -- start_date is local wall clock stored as UTC
         count(*)::int as member_spots
  from mdapi_matches m
  join mdapi_match_players p on p.match_api_id = m.api_id and p.deleted_at is null
  join fin_venue_fields l on l.mdapi_field_id = m.field_id and l.excluded_from_venue is not true
  join fin_venues v on v.id = l.fin_venue_id
  where m.deleted_at is null
    and m.is_cancelled is not true
    and m.city_identifier in ('ATX','HOU','SATX','DFW','ATL','OKC','STL','ELP')
    and (m.start_date at time zone 'UTC')::date between p_from and p_to
    and p.paid_status = 'FREE'
    and p.user_is_fake_player is not true
    and coalesce(p.user_email, '') !~* '@matchday\.com$'
    and p.is_absent is not true
    and p.canceled_at is null
    and coalesce(p.user_type, '') <> 'GUEST'
    and exists (
      select 1 from paid_member_subscription s          -- was mdapi_subscriptions: any row at all
      where s.user_id = p.user_id and s.activation_date is not null
        and s.activation_date <= coalesce(m.start_date_utc, m.start_date)
        and (s.canceled_at is null or s.canceled_at > coalesce(m.start_date_utc, m.start_date))
    )
  group by 1, 2, 3;
$$;
GRANT EXECUTE ON FUNCTION public.fin_member_spots_by_venue_month(date, date) TO authenticated;

-- ── 3. THE FINDER'S is_member — 0147's matview, one expression changed ───────────────────────
-- No CASCADE: nothing depends on this matview's row type (the finder functions read its columns by
-- name). If something unexpected does, the DROP fails and the whole transaction rolls back.
DROP MATERIALIZED VIEW IF EXISTS public.player_finder_mv;
CREATE MATERIALIZED VIEW public.player_finder_mv AS
SELECT
  u.id,
  u.email,
  u.first_name,
  u.last_name,
  u.phone_number,
  u.created_at,
  u.preferable_city_name,
  EXISTS (
    SELECT 1 FROM public.paid_member_subscription s
    WHERE s.user_id = u.id AND s.status = 'ACTIVE'
  )                                    AS is_member,   -- was u.is_member
  coalesce(ps.plays, 0)::int as plays,
  ps.last_played,
  lower(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '') || ' ' ||
        coalesce(u.email, '') || ' ' || coalesce(u.phone_number, '') || ' ' ||
        u.id::text) as search_blob
FROM public.mdapi_users u
LEFT JOIN public.player_play_stats ps ON ps.user_id = u.id
WHERE u.is_fake_player IS NOT TRUE;

CREATE UNIQUE INDEX player_finder_mv_id_idx        ON public.player_finder_mv (id);
CREATE INDEX        player_finder_mv_created_idx   ON public.player_finder_mv (created_at desc, id);
CREATE INDEX        player_finder_mv_city_idx      ON public.player_finder_mv (preferable_city_name);
CREATE INDEX        player_finder_mv_plays_idx     ON public.player_finder_mv (plays);
CREATE INDEX        player_finder_mv_lastplay_idx  ON public.player_finder_mv (last_played);

REVOKE ALL ON public.player_finder_mv FROM anon, authenticated;
GRANT SELECT ON public.player_finder_mv TO service_role;

COMMIT;

-- Stamp the freshness row the Finder reads (the matview is already populated by CREATE).
SELECT public.refresh_player_finder_views();

-- ── READ-BACK: run after, expect the comments' shapes ────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.paid_member_subscription WHERE status = 'ACTIVE')        AS active_paying_rows,
  (SELECT count(*) FROM public.player_finder_mv WHERE is_member)                         AS finder_members,
  (SELECT count(*) FROM public.mdapi_users WHERE is_member AND is_fake_player IS NOT TRUE) AS finder_members_before,
  (SELECT sum(member_spots) FROM public.fin_member_spots_by_venue_month('2026-09-01', '2026-09-30')) AS sep_member_spots;
