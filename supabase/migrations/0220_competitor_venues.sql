-- 0220 COMPETITOR VENUES — where the Plei and GoodRec facilities ARE, for the Locations map.
--
-- Seeded from data/competitor-locations.csv (one row per Plei or GoodRec listing, 52 rows, built by
-- hand from Google Maps place ids). Two tables, because one place can carry several listings:
--
--   competitor_venues          one physical place: name, address, lat/lng. Admins can correct the
--                              address or drag the pin on the map; updated_at / updated_by say who.
--   competitor_venue_listings  one Plei or GoodRec listing at that place. (source, city_label,
--                              facility) is the SAME key competitor_facility_rulings uses, and joins
--                              to competitor_facility_supply through its capture — so spots per week,
--                              price and formats come from the capture, never from here.
--
-- MERGED: listings in the same market at the same coordinates are one venue (9 venues, 54 listings
-- across 45 venues). A row the CSV only says is PROBABLY the same place (City Futsal on Plei,
-- Salient Touch on GoodRec) has no coordinates and is left as its own unplaced venue.
--
-- NOT PLACED: lat/lng null. Both or neither (CHECK). The map lists these with the CSV's reason.
--
-- RLS: the same gate as the rest of the competitor data (0179's competitor_data_readable(): Growth or
-- admin, confinement beats every flag, service accounts out). Writes are service role only — the
-- admin-gated route /api/growth/locations/competitors, which logs every change to change_log.

create table if not exists public.competitor_venues (
  id             bigserial primary key,
  market         text not null,               -- the capture's city_label: 'Dallas / Fort Worth', 'Houston'
  name           text not null,
  street_address text,
  city           text,
  state          text,
  zip            text,
  lat            double precision,
  lng            double precision,
  confidence     text check (confidence in ('high', 'medium', 'low', 'not_found')),
  updated_at     timestamptz,
  updated_by     text,
  created_at     timestamptz not null default now(),
  constraint competitor_venues_coords_pair check ((lat is null) = (lng is null)),
  constraint competitor_venues_coords_range check (lat is null or (lat between -90 and 90 and lng between -180 and 180))
);

create table if not exists public.competitor_venue_listings (
  id          bigserial primary key,
  venue_id    bigint not null references public.competitor_venues(id) on delete cascade,
  source      text not null check (source in ('plei', 'goodrec')),
  city_label  text not null,
  facility    text not null,                  -- = competitor_facility_supply.facility
  source_url  text,
  confidence  text check (confidence in ('high', 'medium', 'low', 'not_found')),
  notes       text,
  constraint competitor_venue_listings_key unique (source, city_label, facility)
);
create index if not exists competitor_venue_listings_venue_idx on public.competitor_venue_listings (venue_id);

alter table public.competitor_venues enable row level security;
alter table public.competitor_venue_listings enable row level security;

drop policy if exists competitor_venues_read on public.competitor_venues;
create policy competitor_venues_read on public.competitor_venues
  for select to authenticated using (public.competitor_data_readable());
drop policy if exists competitor_venue_listings_read on public.competitor_venue_listings;
create policy competitor_venue_listings_read on public.competitor_venue_listings
  for select to authenticated using (public.competitor_data_readable());

-- ── SEED: data/competitor-locations.csv ───────────────────────────────────────────────────────
-- Guarded so a second run inserts nothing: the seed only runs into an empty table.
do $seed$
begin
if exists (select 1 from public.competitor_venues) then
  raise notice 'competitor_venues already has rows; seed skipped';
  return;
end if;

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'City Futsal (location unresolved)', null, null, 'TX', null, null, null, 'low')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'City Futsal', 'https://www.cityfutsal.com/', 'low', 'AMBIGUOUS. Likely the Farmers Market site (1224 S Cesar Chavez Blvd, Dallas 75201; 32.77697,-96.78763) because Plei lists The Colony separately. Confirm in the Plei listing')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Crossbar Soccer + Beer', '2686 Old Alton Rd', 'Denton', 'TX', '76210', 33.13030, -97.10263, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'Crossbar, Denton', 'https://www.google.com/maps/place/?q=place_id:ChIJKT5L577NTYYRs8heGwJfzZU', 'high', 'Salient Touch also trains here')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'City Futsal (Austin Ranch)', '5812 Windhaven Pkwy', 'The Colony', 'TX', '75056', 33.05734, -96.86241, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'City Futsal The Colony', 'https://www.google.com/maps/place/?q=place_id:ChIJgUo5JPMlTIYRUZ73w_tjvxg', 'high', 'Same venue as City Futsal Austin Ranch (GoodRec)'),
  ('goodrec', 'Dallas / Fort Worth', 'City Futsal, Austin Ranch', 'https://visitthecolonytx.com/481/City-Futsal-at-Austin-Ranch', 'high', 'Same venue as City Futsal The Colony (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Salient Touch Futbol Academy (North Richland Hills)', '6428 Davis Blvd Bldg 3', 'North Richland Hills', 'TX', '76182', 32.86558, -97.20662, 'low')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Salient Touch Futbol Academy', 'https://www.google.com/maps/place/?q=place_id:ChIJMSLPoR95ToYRO2DPJdDAyxk', 'low', 'AMBIGUOUS. 3 DFW sites: NRH (most likely), Carrollton 1400 W Hebron Pkwy 75010, Denton inside Crossbar Denton. Confirm in the Plei listing')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Salient Touch Futbol Academy (location unresolved)', null, null, 'TX', null, null, null, 'low')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'Salient Touch', 'https://www.salienttouch.com/', 'low', 'AMBIGUOUS. Same 3 candidates; NRH most likely. Probably the same venue as the Plei listing')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Foro Sports Club', '14725 Preston Rd', 'Dallas', 'TX', '75254', 32.94870, -96.80688, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Foro Sports Club', 'https://www.google.com/maps/place/?q=place_id:ChIJVQQ_-hohTIYRb4IpAcoFY9c', 'high', 'Same venue as Foro Sports (GoodRec)'),
  ('goodrec', 'Dallas / Fort Worth', 'Foro Sports', 'https://www.google.com/maps/place/?q=place_id:ChIJVQQ_-hohTIYRb4IpAcoFY9c', 'high', 'Same venue as Foro Sports Club (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Crossbar Soccer + Beer', '1000 Hampshire Ln', 'Richardson', 'TX', '75080', 32.96110, -96.73778, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'Crossbar, Richardson', 'https://www.google.com/maps/place/?q=place_id:ChIJGftQe0MfTIYRsjKmUKIR6xM', 'high', 'Same venue as Crossbar Soccer + Beer Richardson (Plei)'),
  ('plei', 'Dallas / Fort Worth', 'Crossbar Soccer + Beer | Richardson', 'https://www.google.com/maps/place/?q=place_id:ChIJGftQe0MfTIYRsjKmUKIR6xM', 'high', 'Same venue as Crossbar Richardson (GoodRec)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'ULETE', '2308 Dean Way', 'Southlake', 'TX', '76092', 32.93084, -97.11480, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Ulete', 'https://www.google.com/maps/place/?q=place_id:ChIJEzNR9ZDVTYYR1Go_UXzsWSI', 'high', 'Same venue as Ulete Southlake (GoodRec)'),
  ('goodrec', 'Dallas / Fort Worth', 'Ulete, Southlake', 'https://www.google.com/maps/place/?q=place_id:ChIJEzNR9ZDVTYYR1Go_UXzsWSI', 'high', 'Same venue as Ulete (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Athlete Training and Health - Allen', '1110 Raintree Cir #1220', 'Allen', 'TX', '75013', 33.11484, -96.67470, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'ATH, Allen', 'https://www.google.com/maps/place/?q=place_id:ChIJud44Ku0XTIYRzhtUV09HP4I', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Pro Touch Soccer Center', '10717E Northwest Hwy', 'Dallas', 'TX', '75238', 32.86514, -96.69941, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Pro Touch Soccer Center', 'https://www.google.com/maps/place/?q=place_id:ChIJX47kQfqgToYRJj4JvcvnX0w', 'high', 'Same venue as Pro Touch Lake Highlands (GoodRec)'),
  ('goodrec', 'Dallas / Fort Worth', 'Pro Touch, Lake Highlands', 'https://www.google.com/maps/place/?q=place_id:ChIJX47kQfqgToYRJj4JvcvnX0w', 'high', 'Same venue as Pro Touch Soccer Center (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Vaqueros Field at Sycamore Park', '2400 E Vickery Blvd', 'Fort Worth', 'TX', '76104', 32.73564, -97.29664, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Vaqueros Field at Sycamore Park', 'https://www.google.com/maps/place/?q=place_id:ChIJDbWaq79xToYREzG2jRslSfY', 'high', 'Outdoor public park field')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Rockwall Indoor Sports World', '2922 S Goliad St', 'Rockwall', 'TX', '75032', 32.88858, -96.44127, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Rockwall Indoor Sports World', 'https://www.google.com/maps/place/?q=place_id:ChIJ05M3bP6rToYRuDBskoyRYU4', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'UMB Bank Performance Center', '9966 John W. Elliott Dr', 'Frisco', 'TX', '75033', 33.16065, -96.82781, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'UMB Bank Performance Center', 'https://www.google.com/maps/place/?q=place_id:ChIJlV17bCM9TIYR3MJQ4qByl3k', 'high', 'Same venue as UMB Bank Frisco (GoodRec)'),
  ('goodrec', 'Dallas / Fort Worth', 'UMB Bank, Frisco', 'https://www.google.com/maps/place/?q=place_id:ChIJlV17bCM9TIYR3MJQ4qByl3k', 'high', 'Same venue as UMB Bank Performance Center (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'City Futsal (Dallas Farmers Market)', '1224 S Cesar Chavez Blvd', 'Dallas', 'TX', '75201', 32.77697, -96.78763, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'CityFutsal Farmers Market', 'https://www.google.com/maps/place/?q=place_id:ChIJ95t6Hq2ZToYR-4azYsBuLn8', 'high', 'Probably the same venue as plain City Futsal (Plei)')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Upper 90 Soccer Center', '1118 California Ln', 'Arlington', 'TX', '76015', 32.69851, -97.12505, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Upper 90 Soccer Center', 'https://www.google.com/maps/place/?q=place_id:ChIJmYI6nTJ9ToYR3I71Y4NHus8', 'high', 'Listed on both apps'),
  ('goodrec', 'Dallas / Fort Worth', 'Upper 90 Soccer Center', 'https://www.google.com/maps/place/?q=place_id:ChIJmYI6nTJ9ToYR3I71Y4NHus8', 'high', 'Listed on both apps')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'SoccerZone', '3254 W Camp Wisdom Rd', 'Dallas', 'TX', '75237', 32.66104, -96.87357, 'medium')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'SoccerZone', 'https://www.google.com/maps/place/?q=place_id:ChIJ60sZo3SRToYR4xmW4CyD1Fg', 'medium', 'Name match only')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'TOCA Soccer Center The Colony', '7801 Main St', 'The Colony', 'TX', '75056', 33.11315, -96.89333, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'TOCA Soccer Center | The Colony', 'https://www.google.com/maps/place/?q=place_id:ChIJBTmaNPE6TIYR5PT6eO1SeBc', 'high', 'Listed on both apps'),
  ('goodrec', 'Dallas / Fort Worth', 'TOCA, Colony', 'https://www.google.com/maps/place/?q=place_id:ChIJBTmaNPE6TIYR5PT6eO1SeBc', 'high', 'Listed on both apps')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Gateway Park Synthetic Fields', 'Players Pkwy', 'Fort Worth', 'TX', '76117', 32.76134, -97.27855, 'medium')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'Gateway Park, Fort Worth', 'https://www.google.com/maps/place/?q=place_id:ChIJLRPMDPpxToYRAjuVd_UiZqI', 'medium', 'No street number; large park')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'TOCA Soccer Center Allen', '950 E Main St', 'Allen', 'TX', '75002', 33.09923, -96.64703, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'TOCA, Allen', 'https://www.google.com/maps/place/?q=place_id:ChIJ34KrTLkQTIYRGH4CTxUnQXE', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Futbol 360 Soccer Complex', '3620 W Davis St', 'Dallas', 'TX', '75211', 32.74936, -96.87907, 'medium')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Fut360', 'https://www.google.com/maps/place/?q=place_id:ChIJC5iLtPiaToYRYQ7Za8cpFmo', 'medium', 'Name match only')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'TOCA Soccer Center Carrollton', '1850 Legends Trail', 'Carrollton', 'TX', '75006', 32.96669, -96.93562, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'TOCA, Carrollton', 'https://www.google.com/maps/place/?q=place_id:ChIJleQNGjwpTIYRksta8gWgV8c', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Forney Indoor Training (FIT)', '7 Mustang Cir', 'Forney', 'TX', '75126', 32.75111, -96.45850, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('goodrec', 'Dallas / Fort Worth', 'FIT - Forney', 'https://www.google.com/maps/place/?q=place_id:ChIJC4ZoqpCtToYR2zyhSRGxx8k', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'Keller Fields | Futbol Evolution', null, null, 'TX', null, null, null, 'not_found')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'Keller Fields | Futbol Evolution', null, 'not_found', 'Not found. Possibly Keller Sports Park, 1 Sports Pkwy, Keller 76248. Confirm in the Plei listing')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Dallas / Fort Worth', 'North Park Soccer Fields', '8750 N Beach St', 'Fort Worth', 'TX', '76244', 32.90284, -97.28845, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Dallas / Fort Worth', 'North Park Soccer Fields', 'https://www.google.com/maps/place/?q=place_id:ChIJMWl8WkjYTYYRLzwQH35hdOY', 'high', 'City of Fort Worth outdoor fields')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Revolution Soccer Complex', '15111 Ella Blvd', 'Houston', 'TX', '77090', 29.98639, -95.43359, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Revolution Soccer Complex', 'https://www.google.com/maps/place/?q=place_id:ChIJc7KMA_XLQIYRcNWSB5i8eBY', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Houston Toros Soccer Facility', '2202 Summer St', 'Houston', 'TX', '77007', 29.77336, -95.38068, 'medium')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Toros Lifestyle Soccer Art District', 'https://www.google.com/maps/place/?q=place_id:ChIJy5kVSJK5QIYRZ4lige6by9g', 'medium', 'Matched by brand; two futsal courts at Sawyer Yards')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Pegaso HTX', '2619 Polk St', 'Houston', 'TX', '77003', 29.74639, -95.35201, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Pegaso HTX', 'https://www.google.com/maps/place/?q=place_id:ChIJf2F9KrK_QIYRlhqgq8RuCmg', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'HTX FieldHouse', '716 Telephone Rd', 'Houston', 'TX', '77023', 29.73416, -95.33166, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'HTX Fieldhouse', 'https://www.google.com/maps/place/?q=place_id:ChIJz5i4uPa_QIYRs_4TTIeiPGI', 'high', 'New venue')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Houston Soccer Field', '18850 FM 529', 'Cypress', 'TX', '77433', 29.88014, -95.69771, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Houston Soccer Field', 'https://www.google.com/maps/place/?q=place_id:ChIJYwnTqjHXQIYRDyENYgvwCWo', 'high', 'About 450 m from King Soccer')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'GoPro Arena', null, null, 'TX', null, null, null, 'not_found')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'GoPro Arena', null, 'not_found', 'Not found. Confirm in the Plei listing')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Crossbar Academy', '17822 Hufsmith-Kohrville Rd', 'Tomball', 'TX', '77375', 30.02641, -95.58554, 'low')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Crossbar Academy', 'https://www.google.com/maps/place/?q=place_id:ChIJc13Z2cTTQIYR_V4ZagQKtGI', 'medium', 'Same address as Crossbar Academy Indoor Soccer'),
  ('plei', 'Houston', 'Crossbar Academy | Indoor Soccer', 'https://www.google.com/maps/place/?q=place_id:ChIJc13Z2cTTQIYR_V4ZagQKtGI', 'low', 'Assumed same site as Crossbar Academy')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Peek Sports Tx', '4060 Peek Rd', 'Katy', 'TX', '77449', 29.84746, -95.77257, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Peek Sports Texas', 'https://www.google.com/maps/place/?q=place_id:ChIJKwMBmCEnQYYRzDwbT8W7jRU', 'high', 'Same phone as Houston Select Soccer')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Hattrick Oakridge', '28137 Robinson Rd', 'Conroe', 'TX', '77385', 30.15572, -95.42558, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'The HatTrick Oakridge', 'https://www.google.com/maps/place/?q=place_id:ChIJq0NbZ1Q3R4YR70SWb1HpGn4', 'high', 'Hattrick location; partner brand')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Hattrick Patio', '25155 Hufsmith-Kohrville Rd', 'Tomball', 'TX', '77375', 30.12693, -95.59403, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'The HatTrick Patio', 'https://www.google.com/maps/place/?q=place_id:ChIJ7xa2R-ktR4YRVYNj01t8iVY', 'high', 'About 0.5 km from 11121 Hufsmith Rd, which is our field The Hattrick T. Likely the same complex: check before showing as a competitor')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Athlete Training and Health - Cypress', '27646 Northwest Fwy', 'Cypress', 'TX', '77433', 29.98579, -95.73102, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Athlete Training & Health | Cypress', 'https://www.google.com/maps/place/?q=place_id:ChIJifE57YsrQYYRYgaI_GrfOHQ', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Canchas Five Stars', '3800 Hillcroft St', 'Houston', 'TX', '77057', 29.72461, -95.50181, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Cancha Five Stars | Hillcroft', 'https://www.google.com/maps/place/?q=place_id:ChIJq4oL6XXDQIYRv88eSzDm49Y', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Q&B Sports', '1739 Bingle Rd', 'Houston', 'TX', '77055', 29.80234, -95.50114, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Q&B Indoor Sports', 'https://www.google.com/maps/place/?q=place_id:ChIJqZn3fUjEQIYRte8Oz1NM7nw', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Memorial Indoor Soccer Academy', '1322 S Dairy Ashford Rd', 'Houston', 'TX', '77077', 29.75799, -95.60669, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Memorial Indoor Soccer', 'https://www.google.com/maps/place/?q=place_id:ChIJCVBh9p7bQIYRc0M9hN7pnEw', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Futbolito-Golfo de Mexico', '1060 Galveston St', 'South Houston', 'TX', '77587', 29.65878, -95.24776, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Futbolito-Golfo de Mexico', 'https://www.google.com/maps/place/?q=place_id:ChIJBeJVh5WXQIYRTiFO2J-FQiY', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'King Soccer', '19120 FM 529', 'Cypress', 'TX', '77433', 29.88079, -95.70232, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'King Soccer', 'https://www.google.com/maps/place/?q=place_id:ChIJu3LlgLzXQIYRhqnQouBFn9Y', 'high', 'About 450 m from Houston Soccer Field')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Houston Sports Park', '12131 Kirby Dr', 'Houston', 'TX', '77045', 29.63803, -95.39533, 'medium')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Houston Dynamo Sports Park', 'https://www.google.com/maps/place/?q=place_id:ChIJxcqO6tTqQIYRnAUZYsEpl_s', 'medium', 'Dynamo-operated park')
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'The InDoorSoccerBox', '1530 W Sam Houston Pkwy N #121', 'Houston', 'TX', '77043', 29.80087, -95.56204, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Indoor Soccer Box', 'https://www.google.com/maps/place/?q=place_id:ChIJadntBAbbQIYRlM2WxDsMz7I', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Community Fieldhouse Sports Bar and Grill', '2007 Riley Fuzzel Rd', 'Spring', 'TX', '77386', 30.10466, -95.40038, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Community Fieldhouse', 'https://www.google.com/maps/place/?q=place_id:ChIJU431-wQ1R4YRy0zz0yMv1Uk', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Paris Saint-Germain Academy Houston', '20212 Franz Rd', 'Katy', 'TX', '77449', 29.80128, -95.73441, 'high')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'PSG Academy Houston', 'https://www.google.com/maps/place/?q=place_id:ChIJ1ZGsOn8nQYYRzTygYg3EnIo', 'high', null)
) as x(source, city_label, facility, source_url, confidence, notes);

with v as (
  insert into public.competitor_venues (market, name, street_address, city, state, zip, lat, lng, confidence)
  values ('Houston', 'Houston Select Soccer', null, 'Houston', 'TX', '77079', null, null, 'low')
  returning id
)
insert into public.competitor_venue_listings (venue_id, source, city_label, facility, source_url, confidence, notes)
select v.id, x.* from v, (values
  ('plei', 'Houston', 'Houston Select FC', 'https://www.google.com/maps/place/?q=place_id:ChIJe-k69KHbQIYR6eFhgICqFdY', 'low', 'No street address. Same phone as Peek Sports Tx, so games may be at 4060 Peek Rd, Katy')
) as x(source, city_label, facility, source_url, confidence, notes);

end
$seed$;

-- Check after applying: expect venues 45, listings 54, placed 40.
-- select (select count(*) from public.competitor_venues) as venues,
--        (select count(*) from public.competitor_venue_listings) as listings,
--        (select count(*) from public.competitor_venues where lat is not null) as placed;
