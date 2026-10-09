-- 0221 ZIP CENTROIDS — place a player from their zip when MatchDay sends no coordinates.
--
-- WHY. On 2026-10-09 the Locations page listed 43 "unidentified zips" that were all valid, inside
-- coverage and set that day. MatchDay HAD coordinates for them, under `currentLat`/`currentLng`;
-- the sync read only `lat`/`lng` (fixed in code). This table is the FALLBACK for a player whose
-- record carries a zip and no coordinates at all: it is used only then, and such a player is
-- labelled "located from zip" (player_area_seen.location_source = 'zip_centroid').
--
-- DATA. US Census Bureau 2024 Gazetteer, ZCTA national file (2024_Gaz_zcta_national.txt): 33,791
-- ZCTAs, GEOID as 5-digit TEXT (leading zeros kept, e.g. 00601), INTPTLAT/INTPTLONG = the Census
-- internal point. Loaded after this runs by a one-off service-role script, not pasted here (33,791
-- rows). Nothing calls an outside geocoder at runtime.
--
-- A ZCTA is not exactly a USPS zip (a PO-box-only or brand-new zip may be missing). A zip with no row
-- here stays "Unidentified", which is the point: Unidentified = a zip we cannot place at all.

create table if not exists public.zip_centroids (
  zip    text primary key,
  lat    double precision not null,
  lng    double precision not null,
  source text not null default 'census-2024-zcta-gazetteer',
  constraint zip_centroids_zip_5 check (zip ~ '^[0-9]{5}$'),
  constraint zip_centroids_lat check (lat between -90 and 90),
  constraint zip_centroids_lng check (lng between -180 and 180)
);

-- Public reference data: any signed-in account may read it; only the service role writes.
alter table public.zip_centroids enable row level security;
drop policy if exists zip_centroids_read on public.zip_centroids;
create policy zip_centroids_read on public.zip_centroids for select to authenticated using (true);

-- WHERE A PLAYER'S COORDINATES CAME FROM: 'matchday' (the record's own coordinates) or
-- 'zip_centroid' (this table). Null = no coordinates.
alter table public.player_area_seen add column if not exists location_source text;
alter table public.player_area_seen drop constraint if exists player_area_seen_location_source;
alter table public.player_area_seen add constraint player_area_seen_location_source
  check (location_source is null or location_source in ('matchday', 'zip_centroid'));

-- Every row placed so far was placed from MatchDay's own coordinates.
update public.player_area_seen set location_source = 'matchday'
 where lat is not null and lng is not null and location_source is null;

-- Check after applying:
-- select (select count(*) from public.zip_centroids) as centroids,
--        (select count(*) from public.player_area_seen where location_source = 'matchday') as from_matchday,
--        (select count(*) from public.player_area_seen where lat is not null) as placed;
