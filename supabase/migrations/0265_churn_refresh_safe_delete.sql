-- 0265 — refresh_churn_player_field: qualify the rebuild's DELETE (pg_safeupdate).
--
-- The first run of 0264's function (2026-11-09 03:44Z, service role) failed with "DELETE requires a WHERE clause"
-- after 16.8 s; the call rolled back and churn_player_field stayed empty. The one change is that line. The rest of
-- the function is 0264's, byte for byte.

BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_churn_player_field(p_rates jsonb, p_default_rate numeric)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '240s'
AS $$
DECLARE n integer;
DECLARE today text := to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD');
BEGIN
  CREATE TEMP TABLE _acct ON COMMIT DROP AS          -- every account → its person
    SELECT u.id AS account_id, COALESCE(l.person_id, u.id) AS person_id
      FROM public.mdapi_users u LEFT JOIN public.growth_person_link l ON l.account_id = u.id;

  CREATE TEMP TABLE _venue ON COMMIT DROP AS         -- field → venue key and label
    SELECT m.field_id,
           CASE WHEN vf.fin_venue_id IS NOT NULL AND NOT COALESCE(vf.excluded_from_venue, false)
                THEN vf.fin_venue_id ELSE -m.field_id END AS venue_key,
           max(CASE WHEN vf.fin_venue_id IS NOT NULL AND NOT COALESCE(vf.excluded_from_venue, false)
                    THEN v.venue_name ELSE m.field_title END) AS venue_label
      FROM (SELECT DISTINCT field_id, field_title FROM public.mdapi_matches WHERE field_id IS NOT NULL) m
      LEFT JOIN public.fin_venue_fields vf ON vf.mdapi_field_id = m.field_id
      LEFT JOIN public.fin_venues v ON v.id = vf.fin_venue_id
     GROUP BY 1, 2;

  CREATE TEMP TABLE _managed ON COMMIT DROP AS       -- (person, match) the person managed, played
    SELECT DISTINCT a.person_id, m.api_id AS match_api_id, m.field_id,
           to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS match_date
      FROM (SELECT api_id, field_id, start_date, manager_id AS mgr FROM public.mdapi_matches
             WHERE deleted_at IS NULL AND NOT COALESCE(is_cancelled, false) AND start_date IS NOT NULL AND manager_id IS NOT NULL
            UNION ALL
            SELECT api_id, field_id, start_date, second_manager_id FROM public.mdapi_matches
             WHERE deleted_at IS NULL AND NOT COALESCE(is_cancelled, false) AND start_date IS NOT NULL AND second_manager_id IS NOT NULL) m
      JOIN _acct a ON a.account_id = m.mgr
     WHERE to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') < today;
  CREATE INDEX ON _managed (person_id, match_api_id);

  CREATE TEMP TABLE _played ON COMMIT DROP AS        -- own PLAYER spot, played, not managed
    SELECT DISTINCT g.user_id AS person_id, g.match_api_id, g.field_id, g.city_identifier, g.match_date
      FROM public.growth_participation g
      JOIN public.mdapi_match_players p ON p.api_id = g.player_api_id
     WHERE p.user_type = 'PLAYER' AND g.match_date < today
       AND NOT EXISTS (SELECT 1 FROM _managed x WHERE x.person_id = g.user_id AND x.match_api_id = g.match_api_id);

  CREATE TEMP TABLE _last ON COMMIT DROP AS          -- each person's last played day (the spend cut-off)
    SELECT person_id, max(match_date)::date AS last_day FROM _played GROUP BY 1;

  CREATE TEMP TABLE _money ON COMMIT DROP AS         -- one Finance-net figure per fin_txn money row
    SELECT t.id, t.charge_id, t.payment_intent_id, t.customer_id, t.kind, t.type,
           (t.created_at_utc AT TIME ZONE 'America/Chicago')::date AS d,
           (t.gross_cents - CASE WHEN t.source = 'Stripe' AND t.kind IN ('charge', 'refund', 'failed', 'dispute')
                                 THEN t.gross_cents - round(t.gross_cents / (1 + rt.rate)) ELSE 0 END)::bigint AS net
      FROM public.fin_txn t
      CROSS JOIN LATERAL (SELECT CASE
          WHEN t.city IS NULL OR btrim(t.city) = '' OR t.city = 'Deleted Account Revenue' THEN p_default_rate
          ELSE COALESCE((p_rates ->> t.city)::numeric, 0) END AS rate) rt
     WHERE t.kind IN ('charge', 'refund', 'failed', 'dispute')
       AND NOT COALESCE(t.is_test, false) AND NOT COALESCE(t.is_internal, false) AND t.exclude_reason IS NULL;
  CREATE INDEX ON _money (payment_intent_id);
  CREATE INDEX ON _money (charge_id);

  -- Booking charges: the person's own booking payment intents (any of their accounts), up to their last played day,
  -- each on the venue of the booking's match.
  CREATE TEMP TABLE _book ON COMMIT DROP AS
    SELECT DISTINCT a.person_id, mo.charge_id, mo.id AS charge_row, v.venue_key
      FROM public.mdapi_match_players p
      JOIN _acct a ON a.account_id = p.user_id
      JOIN public.mdapi_matches m ON m.api_id = p.match_api_id
      JOIN _venue v ON v.field_id = m.field_id
      JOIN _money mo ON mo.payment_intent_id = p.payment_intent_id AND mo.kind = 'charge'
      JOIN _last l ON l.person_id = a.person_id
     WHERE p.payment_intent_id IS NOT NULL AND mo.d <= l.last_day;

  -- the charge itself, plus every refund / failed payment / dispute on it
  CREATE TEMP TABLE _book_net ON COMMIT DROP AS
    SELECT person_id, venue_key, sum(net)::bigint AS cents FROM (
      SELECT b.person_id, b.venue_key, x.net FROM _book b JOIN _money x ON x.id = b.charge_row
      UNION ALL
      SELECT b.person_id, b.venue_key, x.net FROM _book b JOIN _money x ON x.charge_id = b.charge_id AND x.kind <> 'charge'
       WHERE b.charge_id IS NOT NULL
    ) s GROUP BY 1, 2;

  -- Membership charges: invoice payment intent, or the Stripe customer, up to the last played day.
  CREATE TEMP TABLE _mem ON COMMIT DROP AS
    SELECT DISTINCT a.person_id, mo.id AS charge_row, mo.charge_id
      FROM public.stripe_member_invoices i
      JOIN _acct a ON a.account_id = i.md_user_id
      JOIN _money mo ON mo.payment_intent_id = i.payment_intent_id
      JOIN _last l ON l.person_id = a.person_id
     WHERE i.payment_intent_id IS NOT NULL AND mo.kind = 'charge' AND mo.d <= l.last_day
    UNION
    SELECT DISTINCT a.person_id, mo.id, mo.charge_id
      FROM _money mo
      JOIN public.stripe_customers c ON c.customer_id = mo.customer_id
      JOIN _acct a ON a.account_id = c.md_user_id
      JOIN _last l ON l.person_id = a.person_id
     WHERE mo.kind = 'charge' AND mo.type = 'Membership' AND mo.d <= l.last_day;

  CREATE TEMP TABLE _mem_net ON COMMIT DROP AS
    SELECT person_id, sum(net)::bigint AS cents, count(*) FILTER (WHERE is_charge) AS charges FROM (
      SELECT m.person_id, x.net, true AS is_charge FROM _mem m JOIN _money x ON x.id = m.charge_row
      UNION ALL
      SELECT m.person_id, x.net, false FROM _mem m JOIN _money x ON x.charge_id = m.charge_id AND x.kind <> 'charge'
       WHERE m.charge_id IS NOT NULL
    ) s GROUP BY 1;

  -- Per person × venue: matches, managed, dates, and the city of their latest played match there.
  CREATE TEMP TABLE _pv ON COMMIT DROP AS
    SELECT person_id, venue_key, sum(matches)::integer AS matches, sum(managed)::integer AS managed,
           min(first_played) AS first_played, max(last_played) AS last_played,
           (array_agg(city ORDER BY last_played DESC NULLS LAST))[1] AS city
      FROM (
        SELECT p.person_id, v.venue_key, count(DISTINCT p.match_api_id) AS matches, 0 AS managed,
               min(p.match_date)::date AS first_played, max(p.match_date)::date AS last_played,
               (array_agg(p.city_identifier ORDER BY p.match_date DESC))[1] AS city
          FROM _played p JOIN _venue v ON v.field_id = p.field_id GROUP BY 1, 2
        UNION ALL
        SELECT x.person_id, v.venue_key, 0, count(DISTINCT x.match_api_id), NULL::date, NULL::date, NULL::text
          FROM _managed x JOIN _venue v ON v.field_id = x.field_id GROUP BY 1, 2
      ) s
     GROUP BY 1, 2;

  -- pg_safeupdate refuses a DELETE with no WHERE (first run 2026-11-09: "DELETE requires a WHERE clause").
  DELETE FROM public.churn_player_field WHERE person_id IS NOT NULL;
  INSERT INTO public.churn_player_field
    (person_id, venue_key, venue_label, city, matches, managed, booking_cents, membership_cents,
     first_played, last_played, ever_member, refreshed_at)
  SELECT pv.person_id, pv.venue_key, vl.venue_label, pv.city, pv.matches, pv.managed,
         COALESCE(bn.cents, 0),
         -- membership split by share of matches; the remainder goes to the venues with the most matches
         COALESCE(
           floor(mn.cents::numeric * pv.matches / NULLIF(tot.matches, 0))
           + CASE WHEN row_number() OVER (PARTITION BY pv.person_id ORDER BY pv.matches DESC, pv.venue_key)
                      <= (mn.cents - sum(floor(mn.cents::numeric * pv.matches / NULLIF(tot.matches, 0))) OVER (PARTITION BY pv.person_id))
                  THEN 1 ELSE 0 END, 0)::bigint,
         pv.first_played, pv.last_played, COALESCE(mn.charges, 0) > 0, now()
    FROM _pv pv
    JOIN (SELECT venue_key, max(venue_label) AS venue_label FROM _venue GROUP BY 1) vl ON vl.venue_key = pv.venue_key
    LEFT JOIN _book_net bn ON bn.person_id = pv.person_id AND bn.venue_key = pv.venue_key
    LEFT JOIN _mem_net mn ON mn.person_id = pv.person_id
    LEFT JOIN (SELECT person_id, sum(matches) AS matches FROM _pv GROUP BY 1) tot ON tot.person_id = pv.person_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.refresh_churn_player_field(jsonb, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_churn_player_field(jsonb, numeric) TO service_role;

COMMIT;

-- VERDICT. Expect: function_ok = true, qualified_delete = true.
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname = 'refresh_churn_player_field') = 1 AS function_ok,
  (SELECT prosrc LIKE '%DELETE FROM public.churn_player_field WHERE person_id IS NOT NULL%' FROM pg_proc WHERE proname = 'refresh_churn_player_field') AS qualified_delete;
