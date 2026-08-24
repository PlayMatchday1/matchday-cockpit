-- 0142 — two MatchDay field IDs that are hosting real matches and reach Finance as nothing.
--
-- Finance is ALREADY keyed on the field ID: fin_venue_fields maps mdapi_field_id -> fin_venue_id
-- and useFinanceData resolves every registration through it. The defect is that the table is
-- MANUAL, so a new field appears on a match and joins to nothing. Sixteen field IDs are in that
-- state today; these are the two that are live, material and OURS.
--
-- MEASURED BEFORE WRITING (paged reads; amounts converted from cents):
--
--   field 1585  "PARMER Stadium"            Austin       10 matches Aug 2026, 9 live, 1 cancelled
--                                                         269 paid spots, DPP revenue $3,585.00
--   field 1618  "Zipp Family Sports Park"   San Antonio   7 matches Aug 2026, 7 live, 0 cancelled
--                                                          98 paid spots, DPP revenue $568.00
--
-- WARSAW IS DELIBERATELY NOT HERE. field 1684 "Hala Piłkarska Bemowo" has 3 live matches and no
-- venue, and it stays that way: Warsaw is a PARTNER market and must not appear in any of our
-- reports. It gets a venue only once the not-ours flag exists — the same flag that will make New
-- York City's four fields auto-create as inactive. Creating it now and hiding it later is the
-- wrong order: the row would be in the rollups for however long that takes.
--
-- NO RATE IS SET ON NEW BRAUNFELS, DELIBERATELY. per_match_rate and cost_per_match stay NULL so
-- the pitch reports as UNTRACKED rather than as $0 — the treatment Helix Park already gets. A $0
-- rate claims the field is free; NULL claims we do not know yet, and only one of those is true.
-- matchPnL and cityPnl both hold null-cost rows out of Field net rather than counting them at zero.
--
-- SOCCER CENTRAL IS NOT TOUCHED. Its rate is under review and nothing here changes it.
--
-- Apply in the Supabase SQL editor.

begin;

-- 1) PARMER STADIUM — the venue row already exists (id 63); only the link is missing.
insert into fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link, counts_as_regular_play)
select 63, 1585, 'PARMER Stadium', false
where not exists (select 1 from fin_venue_fields where mdapi_field_id = 1585);

-- 2) NEW BRAUNFELS — new venue AND its link in one statement, so the new id is never guessed.
--    Named for the market the operator uses; the pitch's own title is kept on field_name and on
--    the link, so a search for either string finds it.
with v as (
  insert into fin_venues (venue_name, field_name, city, billing_type,
                          per_match_rate, cost_per_match, is_active)
  select 'New Braunfels', 'Zipp Family Sports Park', 'San Antonio', 'per_match',
         null, null, true
  where not exists (select 1 from fin_venues where venue_name = 'New Braunfels' and city = 'San Antonio')
  returning id
)
insert into fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link, counts_as_regular_play)
select v.id, 1618, 'Zipp Family Sports Park', false from v
where not exists (select 1 from fin_venue_fields where mdapi_field_id = 1618);

commit;

-- VERDICT — ONE query, ONE row. The SQL editor shows only the last result set, so everything that
-- matters is in this one.
--   Expected:  links_now 2 | venues_hit 2 | blank_rates 1 | zero_rates 0 | warsaw_links 0 | venues_total 33
--
-- TWO COLUMNS CARRY THE INTENT, not just the count:
--   zero_rates   must be 0 — New Braunfels carries NULL, not 0. Untracked, not free. Anything
--                else and the row is claiming a cost nobody agreed; stop and roll back.
--   warsaw_links must be 0 — proves field 1684 was NOT created. It is the assertion that this
--                file did the smaller thing it was reissued to do.
select
  (select count(*) from fin_venue_fields
    where mdapi_field_id in (1585, 1618))                                  as links_now,
  (select count(distinct fin_venue_id) from fin_venue_fields
    where mdapi_field_id in (1585, 1618))                                  as venues_hit,
  (select count(*) from fin_venue_fields f join fin_venues v on v.id = f.fin_venue_id
    where f.mdapi_field_id = 1618
      and v.per_match_rate is null and v.cost_per_match is null)           as blank_rates,
  (select count(*) from fin_venue_fields f join fin_venues v on v.id = f.fin_venue_id
    where f.mdapi_field_id = 1618
      and (v.per_match_rate = 0 or v.cost_per_match = 0))                  as zero_rates,
  (select count(*) from fin_venue_fields where mdapi_field_id = 1684)      as warsaw_links,
  (select count(*) from fin_venues)                                        as venues_total;

-- ROLLBACK (nothing else references these rows yet):
--   delete from fin_venue_fields where mdapi_field_id in (1585, 1618);
--   delete from fin_venues where venue_name = 'New Braunfels' and city = 'San Antonio';
