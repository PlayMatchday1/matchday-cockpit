-- 0222 — member spots per venue per month, summed in the database (draft for review; not applied).
create or replace function public.fin_member_spots_by_venue_month(p_from date, p_to date)
returns table (fin_venue_id bigint, city text, month date, member_spots integer)
language sql stable security invoker set search_path = public as $$
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
      select 1 from mdapi_subscriptions s
      where s.user_id = p.user_id and s.activation_date is not null
        and s.activation_date <= coalesce(m.start_date_utc, m.start_date)
        and (s.canceled_at is null or s.canceled_at > coalesce(m.start_date_utc, m.start_date))
    )
  group by 1, 2, 3;
$$;
grant execute on function public.fin_member_spots_by_venue_month(date, date) to authenticated;
