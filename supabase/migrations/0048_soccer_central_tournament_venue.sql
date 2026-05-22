-- New fin_venues row for the Soccer Central tournament rate ($120,
-- two side-by-side 9v9 fields). Companion to the existing
-- "Soccer Central" row in San Antonio ($60, one field). At read
-- time resolveSplitRateVenueId picks this leg for matches with
-- mdapi_matches.max_player_count > 22; capacity ≤ 22 stays on the
-- $60 leg; null/0 capacity ("World Cup Tournament" bracket special
-- events) are excluded from cost entirely (resolver returns null).
--
-- charge_on_cancel inherited from the existing Soccer Central row
-- so the two legs stay in lockstep on the policy axes that aren't
-- the rate.
--
-- The new row is NOT added to fin_venue_fields — every Soccer
-- Central mdapi_field_id continues to resolve to the primary venue
-- via the existing mapping. The leg routing happens at read time
-- in code (src/lib/venueGroups.ts:resolveSplitRateVenueId).
--
-- Apply via Supabase Dashboard → SQL Editor.

INSERT INTO fin_venues (
  city,
  venue_name,
  raw_venue_name,
  billing_type,
  per_match_rate,
  cost_per_match,
  charge_on_cancel
)
SELECT
  city,
  'Soccer Central Tournament',
  'Soccer Central Tournament',
  'per_match',
  120,
  120,
  charge_on_cancel
FROM fin_venues
WHERE city = 'San Antonio' AND venue_name = 'Soccer Central'
ON CONFLICT (city, venue_name) DO NOTHING;
