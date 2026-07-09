-- ============================================================
-- fin_venues + fin_venue_fields — Lowell H. Strike Middle School
-- ============================================================
-- New DFW venue, bookable on the MatchDay platform (mdapi field_id
-- 1387, "Lowell H. Strike Middle School", The Colony) with live
-- bookings from 2026-06-22 onward. The daily mdapi_matches sync
-- already carries the field inline, but the Master Schedule
-- "+ Add session" venue dropdown reads fin_venues x fin_venue_fields
-- (a hand-seeded map, last touched by migration 0041), so the venue
-- was absent from the dropdown until linked here.
--
-- city is set to 'Dallas' to match the other DFW venues
-- (Majestic Gardens, Carroll Senior HS, Crossbar Rowlett,
-- Bicentennial Park), which all use 'Dallas' even though the mdapi
-- city_name is "Dallas / Fort Worth"; the dropdown filters on this
-- value.
--
-- Billing: per_match flat $100.
-- ============================================================

-- 1. New fin_venues row
INSERT INTO fin_venues (venue_name, city, is_active, billing_type, cost_per_match)
VALUES ('Lowell H. Strike M.S.', 'Dallas', true, 'per_match', 100);

-- 2. Link to the mdapi field_id. Subquery resolves the auto-assigned
-- id from step 1.
INSERT INTO fin_venue_fields (fin_venue_id, mdapi_field_id, field_title_at_link)
SELECT id, 1387, 'Lowell H. Strike Middle School'
FROM fin_venues
WHERE venue_name = 'Lowell H. Strike M.S.' AND city = 'Dallas';
