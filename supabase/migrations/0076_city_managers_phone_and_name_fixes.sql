-- City Manager phone numbers + two name-spelling fixes.
--
-- The Field Ops page derives the City Manager (name, and now phone) from
-- city_managers by joining fin_venues.city → city_managers.city. This
-- adds the phone column, populates it (E.164), and corrects two spellings
-- to Ryan's canonical: Yarra → Yara (Houston), Willfried → Wilfried
-- (St. Louis). Atlanta and El Paso have no manager — left null.
--
-- ORDERING: the Field Ops page SELECTs manager_phone, so this migration
-- must be applied BEFORE the code deploys (same hard dependency as 0074).
-- Run this in the SQL Editor first, then the merge/deploy proceeds.
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE city_managers
  ADD COLUMN IF NOT EXISTS manager_phone text;

UPDATE city_managers SET manager_phone = '+15129541102' WHERE manager_name ILIKE 'Garrett';
UPDATE city_managers SET manager_phone = '+18178741582' WHERE city = 'Dallas';
UPDATE city_managers SET manager_phone = '+13464298057' WHERE city = 'Houston';
UPDATE city_managers SET manager_phone = '+12105716474' WHERE city = 'San Antonio';
UPDATE city_managers SET manager_phone = '+16368490975' WHERE city = 'St. Louis';
UPDATE city_managers SET manager_phone = '+15723589682' WHERE city = 'OKC';

-- Spelling fixes to match Ryan's canonical.
UPDATE city_managers SET manager_name = 'Yara'     WHERE city = 'Houston';
UPDATE city_managers SET manager_name = 'Wilfried' WHERE city = 'St. Louis';

-- Atlanta, El Paso: no manager row → no name/phone (stay absent).
