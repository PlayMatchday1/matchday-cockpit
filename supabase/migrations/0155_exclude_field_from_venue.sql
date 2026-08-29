-- ============================================================
-- 0155 — EXCLUDE A FIELD FROM ITS VENUE'S NUMBERS, REVERSIBLY
--
-- WHAT IT IS FOR. Some field IDs are one-offs and special events that sit on a real venue but
-- should not count toward it: 1123 "Soccer Central World Cup Tournament" runs on Soccer Central
-- and is 33 matches of tournament that nobody wants inside Soccer Central's operating figures.
-- Today the only ways to stop that are unlink and re-point, which rewrite history and are
-- deliberately not built. This is the reversible one-click alternative.
--
-- ON  = the field STAYS on its venue, still appears in the list, and is left out of the venue's
--       matches / spots / revenue and of every finance surface that reads the mapping.
-- OFF = counts, exactly as today. It is the default and it is what all 48 existing links get.
--
-- ── WHY NOT counts_as_regular_play ────────────────────────────────────────────────────────────
-- Because it means something else. counts_as_regular_play says "this tournament field bills as
-- two pitches" — it DOUBLES a venue's cost basis. This says "leave it out of the venue entirely".
-- A field can legitimately be one and not the other, and overloading one column with two meanings
-- is how per_match_rate and cost_per_match ended up $36 apart on Westlake with nobody able to say
-- which was meant. Two facts, two columns.
--
-- ── REVERSIBLE, WHICH IS WHY THERE IS NO CONFIRMATION IN THE UI ───────────────────────────────
-- Nothing is destroyed: the link row is untouched apart from this boolean, field_title_at_link
-- and created_at still say when and as what it was linked, and flipping it back restores the
-- venue's figures exactly. That is the whole reason a confirm dialog on every click would be
-- wrong on a list of 48.
--
-- ── NOT NULL DEFAULT FALSE, deliberately ──────────────────────────────────────────────────────
-- A nullable flag would give three states for a two-state fact and every reader would have to
-- decide what null meant. It backfills every existing row to false, which is today's behaviour.
--
-- REVERSING THIS MIGRATION:
--   ALTER TABLE fin_venue_fields DROP COLUMN excluded_from_venue;
-- ============================================================

ALTER TABLE fin_venue_fields
  ADD COLUMN IF NOT EXISTS excluded_from_venue boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN fin_venue_fields.excluded_from_venue IS
  'true = this field stays linked to the venue but is left OUT of the venue''s matches, spots, '
  'revenue and cost on every finance surface. For one-offs and special events that run at a real '
  'venue but should not count toward it. Reversible; set from Venues & Fields. NOT the same as '
  'counts_as_regular_play, which doubles a venue''s cost basis.';

-- Partial index: the excluded set is the small one and is what every filter looks for.
CREATE INDEX IF NOT EXISTS fin_venue_fields_excluded_idx
  ON fin_venue_fields (mdapi_field_id) WHERE excluded_from_venue;

-- fin_change_log already accepts fin_venue_fields (migration 0130 widened the CHECK allowlist),
-- so an exclude toggle is recorded there with no further change. Verified before writing this.
