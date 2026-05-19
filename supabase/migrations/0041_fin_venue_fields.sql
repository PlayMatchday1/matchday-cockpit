-- ============================================================
-- fin_venue_fields — junction between fin_venues and mdapi fields
-- ============================================================
-- Foundation table for the venue field_id migration (PR-A). Each
-- row binds one mdapi field_id to one fin_venues row, so future
-- read paths (discrepancy banner, Finance Field Ranking, member
-- spot reconciliation) can join on the stable numeric field_id
-- instead of name-string canonicalization.
--
-- One mdapi field maps to exactly one fin_venues row (UNIQUE on
-- mdapi_field_id). One fin_venues row can collect multiple mdapi
-- fields (the venueAliases.ts arrays already prove this happens —
-- e.g. "ATH Pearland" and "Tourney ATH Pearland" are distinct
-- mdapi fields that operationally are the same physical venue).
--
-- field_title_at_link is captured for audit / debuggability so a
-- future drift between the recorded title and the live mdapi
-- field_title can be detected without losing the original link.
--
-- This migration also adds three previously-unlinked fin_venues
-- rows (Helix Park retired, Crossbar Rowlett new, Hattrick T. new)
-- and seeds 35 field_id links. Two intentional omissions:
--   - fin_venues id=23 (ATH Katy Sunday) is a billing artifact
--     for split-rate accounting, not a separate physical venue.
--   - fin_venues id=49 (Westlake) has no mdapi matches and no
--     schedule_master entries; legacy / inactive.
--
-- No read consumers are touched by this migration. The follow-up
-- PRs cut over discrepancy first, then Finance.
-- ============================================================

-- 1. Junction table

CREATE TABLE IF NOT EXISTS fin_venue_fields (
  fin_venue_id        integer       NOT NULL REFERENCES fin_venues(id),
  mdapi_field_id      bigint        NOT NULL UNIQUE,
  field_title_at_link text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (fin_venue_id, mdapi_field_id)
);

CREATE INDEX IF NOT EXISTS fin_venue_fields_mdapi_field_id_idx
  ON fin_venue_fields(mdapi_field_id);

-- 2. New fin_venues rows for previously-unlinked mdapi fields

-- Helix Park: retired venue, last match Feb 28 2026, kept for
-- historical attribution.
INSERT INTO fin_venues (venue_name, city, is_active, billing_type, cost_per_match)
VALUES ('Helix Park', 'Houston', false, 'per_match', null);

-- Crossbar Rowlett: new DFW venue, May 12 2026 onward. Real
-- arrangement is profit_share; billing_type set to per_match with
-- cost 0 as placeholder until profit_share is built in
-- financeCosts.ts. Tracked but not costed for now.
INSERT INTO fin_venues (venue_name, city, is_active, billing_type, cost_per_match)
VALUES ('Crossbar Rowlett', 'Dallas', true, 'per_match', 0);

-- Hattrick T.: new Houston venue, separate physical location from
-- Austin Hattrick. Placeholder cost ($32 matches Austin); real
-- cost updates end of month.
INSERT INTO fin_venues (venue_name, city, is_active, billing_type, cost_per_match)
VALUES ('Hattrick T.', 'Houston', true, 'monthly_flat', 32);

-- 3. Seed fin_venue_fields with known mdapi field_id mappings

INSERT INTO fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link) VALUES
  -- Atlanta
  (17, 430,  'Hammond Park'),
  (16, 958,  'PRUMC'),
  -- Austin
  (3,  1024, 'The Hattrick'),
  (2,  10,   'North East Metropolitan Park'),
  (2,  17,   'NEMP Tournaments'),
  (5,  27,   'Onion Creek'),
  (5,  991,  'Onion Creek - St Pattys Showdown'),
  (4,  12,   'Round Rock Multipurpose Complex'),
  (4,  18,   'Round Rock Tournaments'),
  (4,  25,   'Stadium Field at Round Rock M.C.'),
  (1,  13,   'San Juan Diego Catholic High School'),
  (1,  859,  'Premier at SJD'),
  (6,  925,  'Stony Point High School'),
  -- Dallas
  (13, 628,  'Bicentennial Park'),
  (14, 826,  'Carroll Senior High School'),
  (15, 1255, 'Majestic Gardens'),
  -- El Paso
  (22, 1222, 'Galatzan Park'),
  -- Houston
  (7,  892,  'ATH Katy'),
  (8,  32,   'ATH Pearland'),
  (8,  22,   'Tourney ATH Pearland'),
  (9,  1156, 'Katy International Sports Complex'),
  (10, 1189, 'PAC GLOBAL'),
  -- OKC
  (21, 1090, 'Scissortail Park'),
  -- San Antonio
  (11, 102,  'Soccer Central Complex'),
  (11, 199,  'Tourney at Soccer Central'),
  (11, 1123, 'Soccer Central World Cup Tournament'),
  (11, 1354, 'Premier Match at Soccer Central'),
  (12, 1057, 'STAR Soccer Complex'),
  -- St. Louis
  (20, 760,  'Centennial Commons'),
  (18, 664,  'Lou Fusz Athletic Complex'),
  (18, 992,  'MD Combine at Lou Fusz Athletic Complex'),
  (19, 364,  'Lou Fusz Athletic Training Center');

-- 4. Link the three new fin_venues rows to their mdapi field_ids.
-- Subqueries resolve the auto-assigned ids from step 2.

INSERT INTO fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link)
SELECT id, 793, 'Helix Park'
FROM fin_venues
WHERE venue_name = 'Helix Park' AND city = 'Houston';

INSERT INTO fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link)
SELECT id, 1321, 'Crossbar Rowlett'
FROM fin_venues
WHERE venue_name = 'Crossbar Rowlett' AND city = 'Dallas';

INSERT INTO fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link)
SELECT id, 1288, 'The Hattrick T.'
FROM fin_venues
WHERE venue_name = 'Hattrick T.' AND city = 'Houston';
