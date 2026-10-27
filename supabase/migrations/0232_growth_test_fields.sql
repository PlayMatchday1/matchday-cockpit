-- 0232 GROWTH TEST FIELDS: pins the team drops on Growth > Locations > Map to ask "what if we had a
-- field here?" (Nick, Richardson TX, 2026-10-27).
--
-- NEVER A REAL FIELD. Real fields come from MatchDay (mdapi_matches.raw.field). Nothing outside the
-- Locations map's "Add a test field" panel reads this table: no field count, coverage figure, report
-- or sync anywhere else in the Clubhouse may join it.
--
-- REMOVE IS SOFT: removed_at / removed_by_email are set, the row stays, and the panel hides it. Every
-- add and remove also goes to change_log through /api/growth/locations/test-fields.
--
-- RLS on with NO policies: only the service role (that route) reads or writes. The route lets anyone
-- with Growth see the pins and only admins add or remove them.

create table if not exists public.growth_test_fields (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  lat              double precision not null,
  lng              double precision not null,
  query            text,                       -- what was typed into the search, null for a map click
  created_by_email text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  removed_at       timestamptz,
  removed_by_email text,
  constraint growth_test_fields_name_len check (char_length(btrim(name)) between 1 and 80),
  constraint growth_test_fields_query_len check (query is null or char_length(query) <= 200),
  constraint growth_test_fields_coords check (lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0)),
  constraint growth_test_fields_removed_pair check ((removed_at is null) = (removed_by_email is null))
);

create index if not exists growth_test_fields_live_idx on public.growth_test_fields (created_at) where removed_at is null;

alter table public.growth_test_fields enable row level security;
revoke all on public.growth_test_fields from anon, authenticated;
