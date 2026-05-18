-- ============================================================
-- schedule_master — canonicalize venue values
-- ============================================================
-- Collapses the historical venue variants (field numbers, parens,
-- abbreviations, suffixes) into one clean canonical name per
-- physical venue. The detail column is intentionally untouched —
-- it keeps the per-field text ("NEMP Field 12", "Round Rock MP -
-- Field 1 (Syn)") for the edit modal and bubble tooltip.
--
-- 20 canonical names, identical to the keys in
-- src/lib/venueAliases.ts:VENUE_CANONICAL_MAP.
-- ============================================================

UPDATE schedule_master SET venue = 'San Juan Diego'
  WHERE venue IN (
    'San Juan Diego (SJD)', 'Premier at SJD', 'SJD', 'San Juan Diego',
    'San Juan Diego Catholic High School'
  );

UPDATE schedule_master SET venue = 'Soccer Central'
  WHERE venue LIKE 'Soccer Central%';

UPDATE schedule_master SET venue = 'NEMP'
  WHERE venue IN ('NEMP', 'NEMP Tournaments', 'North East Metropolitan Park')
     OR venue LIKE 'NEMP Field%';

UPDATE schedule_master SET venue = 'ATH Pearland' WHERE venue = 'ATH Pearland';

UPDATE schedule_master SET venue = 'ATH Katy'     WHERE venue = 'ATH Katy';

UPDATE schedule_master SET venue = 'Hattrick Leander'
  WHERE venue IN ('The Hattrick', 'The Hattrick L.', 'The Hattrick L', 'Hattrick',
                  'Hattrick Leander');

UPDATE schedule_master SET venue = 'Bicentennial'
  WHERE venue IN ('Bicentennial Park', 'Bicentennial');

UPDATE schedule_master SET venue = 'PRUMC' WHERE venue = 'PRUMC';

UPDATE schedule_master SET venue = 'Round Rock'
  WHERE venue LIKE 'Round Rock%';

UPDATE schedule_master SET venue = 'Lou Fusz Outdoor'
  WHERE venue LIKE 'Lou Fusz Outdoor%';

UPDATE schedule_master SET venue = 'Onion Creek'     WHERE venue = 'Onion Creek';

UPDATE schedule_master SET venue = 'Scissortail Park' WHERE venue = 'Scissortail Park';

UPDATE schedule_master SET venue = 'Carroll Senior HS'
  WHERE venue IN ('Carroll Senior HS', 'Carroll Senior High School');

UPDATE schedule_master SET venue = 'Stony Point'
  WHERE venue IN ('Stony Point', 'Stony Point High School');

UPDATE schedule_master SET venue = 'Katy International'
  WHERE venue IN ('Katy Intl', 'Katy Intl (KISC)', 'KISC',
                  'Katy International Sports Complex', 'Katy International');

UPDATE schedule_master SET venue = 'Majestic Gardens' WHERE venue = 'Majestic Gardens';

UPDATE schedule_master SET venue = 'Hammond Park'    WHERE venue = 'Hammond Park';

UPDATE schedule_master SET venue = 'STAR'
  WHERE venue LIKE 'STAR%';

UPDATE schedule_master SET venue = 'PAC Global'      WHERE venue = 'PAC Global';

UPDATE schedule_master SET venue = 'Galatzan Park'   WHERE venue = 'Galatzan Park';
