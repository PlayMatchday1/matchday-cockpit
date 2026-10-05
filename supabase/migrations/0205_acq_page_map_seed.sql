-- 0205 — ACQUISITION: which website pages belong to which city (Ryan, 2026-10-04).
--
-- Only what matters: the homepage, the Cities page, each city page, and each venue page rolled up to
-- its city. Everything else (careers, FAQ, blog, typo URLs, …) stays unmapped and is counted under
-- "Other pages". Drafted from the 120 paths the Jul 1 backfill found; the visit counts in the
-- comments are Jul 1 to Oct 4. Exact paths only, so a new page shows up under "Other pages" until a
-- row here moves it. Applied by hand in the Supabase SQL Editor.
--
-- market_key: ATL ATX DFW HTX OKC SATX STL (the ad markets), ELP (El Paso — not live, so the page
-- shows it under "Other cities").

BEGIN;

INSERT INTO public.acq_page_map (match_kind, pattern, market_key, page_kind, label, sort_order) VALUES
  -- homepage and the Cities page (shown together as "Homepage and site-wide")
  ('path_exact', '/',                                   NULL,   'home',   'Homepage',      0),   -- 7,448 visits
  ('path_exact', '/pickup-soccer/',                     NULL,   'cities', 'Cities page',   1),   -- 362

  -- city pages
  ('path_exact', '/pickup-soccer-in-austin/',           'ATX',  'city',   'Austin city page',        10),  -- 870
  ('path_exact', '/pickup-soccer-in-houston/',          'HTX',  'city',   'Houston city page',       10),  -- 276
  ('path_exact', '/pickup-soccer-in-dallas/',           'DFW',  'city',   'Dallas city page',        10),  -- 263
  ('path_exact', '/pickup-soccer-in-atlanta/',          'ATL',  'city',   'Atlanta city page',       10),  -- 252
  ('path_exact', '/pickup-soccer-in-san-antonio/',      'SATX', 'city',   'San Antonio city page',   10),  -- 246
  ('path_exact', '/pickup-soccer-in-st-louis/',         'STL',  'city',   'St. Louis city page',     10),  -- 128
  ('path_exact', '/pickup-soccer-in-oklahoma-city/',    'OKC',  'city',   'OKC city page',           10),  -- 107
  ('path_exact', '/pickup-soccer-in-el-paso/',          'ELP',  'city',   'El Paso city page',       10),  -- 83

  -- venue pages, rolled up to their city
  ('path_exact', '/pickup-soccer-hammond-park-sandy-springs-atlanta/', 'ATL',  'venue', 'Hammond Park',            20),  -- 251
  ('path_exact', '/pickup-soccer-prumc-buckhead-atlanta/',             'ATL',  'venue', 'PRUMC Buckhead',          20),  -- 48
  ('path_exact', '/pickup-soccer-ath-pearland-houston/',               'HTX',  'venue', 'ATH Pearland',            20),  -- 118
  ('path_exact', '/pickup-soccer-katy-isc-houston/',                   'HTX',  'venue', 'Katy ISC',                20),  -- 108
  ('path_exact', '/pickup-soccer-pac-global-cypress-houston/',         'HTX',  'venue', 'PAC Global Cypress',      20),  -- 47
  ('path_exact', '/pickup-soccer-hattrick-tomball-houston/',           'HTX',  'venue', 'Hattrick Tomball',        20),  -- 22
  ('path_exact', '/pickup-soccer-ath-katy-houston/',                   'HTX',  'venue', 'ATH Katy',                20),  -- 18
  ('path_exact', '/pickup-soccer-crossbar-rowlett-dallas/',            'DFW',  'venue', 'Crossbar Rowlett',        20),  -- 73
  ('path_exact', '/pickup-soccer-bicentennial-park-dallas/',           'DFW',  'venue', 'Bicentennial Park',       20),  -- 48
  ('path_exact', '/pickup-soccer-majestic-gardens-dallas/',            'DFW',  'venue', 'Majestic Gardens',        20),  -- 28
  ('path_exact', '/pickup-soccer-carroll-hs-dallas/',                  'DFW',  'venue', 'Carroll HS',              20),  -- 14
  ('path_exact', '/pickup-soccer-star-complex-san-antonio/',           'SATX', 'venue', 'STAR Complex',            20),  -- 64
  ('path_exact', '/pickup-soccer-soccer-central-san-antonio/',         'SATX', 'venue', 'Soccer Central',          20),  -- 48
  ('path_exact', '/pickup-soccer-scissortail-park-okc/',               'OKC',  'venue', 'Scissortail Park',        20),  -- 42
  ('path_exact', '/pickup-soccer-lou-fusz-athletic-st-louis/',         'STL',  'venue', 'Lou Fusz Athletic',       20),  -- 15
  ('path_exact', '/pickup-soccer-lou-fusz-training-center-st-louis/',  'STL',  'venue', 'Lou Fusz Training Center', 20), -- 12
  ('path_exact', '/pickup-soccer-centennial-commons-st-louis/',        'STL',  'venue', 'Centennial Commons',      20),  -- 8
  ('path_exact', '/pickup-soccer-galatzan-park-el-paso/',              'ELP',  'venue', 'Galatzan Park',           20);  -- 13

DO $$ BEGIN
  IF (SELECT count(*) FROM public.acq_page_map) <> 28 THEN
    RAISE EXCEPTION 'expected 28 page-map rows (was the table empty before?) — rolled back';
  END IF;
END $$;

COMMIT;
