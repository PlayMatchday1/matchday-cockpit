// Canonical venue keys map to all known field_title and master
// venue strings. Both schedule_master.venue / .detail AND
// mdapi_matches.field_title get normalized to the canonical key
// via canonicalizeVenue. Used by the /api/schedule-master/
// discrepancies endpoint so the same physical field doesn't show
// up as both "missing" and "extra" just because one side spells
// it differently.
//
// Ops adds new aliases here as they surface. canonicalizeVenue
// logs a console.warn when it returns null so missing aliases
// land in the server logs instead of becoming silent false-
// positives in the discrepancy banner.

// 21 canonical names. Migration 0040 normalizes schedule_master
// .venue to one of these. mdapi_matches.field_title gets the same
// canonicalization on read. Field-level granularity stays in
// schedule_master.detail for the edit modal + bubble tooltip.
export const VENUE_CANONICAL_MAP: Record<string, string[]> = {
  "San Juan Diego": [
    "San Juan Diego",
    "San Juan Diego (SJD)",
    "San Juan Diego Catholic High School",
    "SJD",
    "Premier at SJD",
  ],
  "Soccer Central": [
    "Soccer Central",
    "Soccer Central Complex",
    "Tourney at Soccer Central",
    "Premier Match at Soccer Central",
    "Soccer Central - SC Field 3",
    "Soccer Central - SC Field 4",
    "Soccer Central - SC Field 4A",
  ],
  NEMP: [
    "NEMP",
    "North East Metropolitan Park",
    "NEMP Tournaments",
    "NEMP Field 12",
    "NEMP Field 14",
  ],
  "ATH Pearland": ["ATH Pearland", "Tourney ATH Pearland"],
  "ATH Katy": ["ATH Katy"],
  "Hattrick Leander": [
    "Hattrick Leander",
    "The Hattrick",
    "The Hattrick L.",
    "The Hattrick L",
    "Hattrick",
  ],
  Bicentennial: ["Bicentennial", "Bicentennial Park"],
  PRUMC: ["PRUMC"],
  "Round Rock": [
    "Round Rock",
    "Round Rock MP",
    "Round Rock MP - Field 1",
    "Round Rock MP - Field 1 (Syn)",
    "Round Rock MP - Field 6",
    "Round Rock MP - Field 6 (Gr)",
    "Round Rock MP - Field 7",
    "Round Rock MP - Field 7 (Syn)",
    "Round Rock MP - Field 8",
    "Round Rock MP - Field 8 (Syn)",
    "Round Rock MP - Field 9",
    "Round Rock MP - Field 9 (Syn)",
    "Round Rock MP - Field 10",
    "Round Rock MP - Field 10 (Syn)",
  ],
  "Lou Fusz Outdoor": [
    "Lou Fusz Outdoor",
    "Lou Fusz Athletic Complex",
    "Lou Fusz Outdoor (Field 10)",
    "Lou Fusz Outdoor (Field 5)",
  ],
  "Onion Creek": ["Onion Creek"],
  "Scissortail Park": ["Scissortail Park"],
  "Carroll Senior HS": ["Carroll Senior HS", "Carroll Senior High School"],
  "Stony Point": ["Stony Point", "Stony Point High School"],
  "Katy International": [
    "Katy International",
    "Katy Intl",
    "Katy Intl (KISC)",
    "KISC",
    "Katy International Sports Complex",
  ],
  "Majestic Gardens": ["Majestic Gardens"],
  "Hammond Park": ["Hammond Park"],
  STAR: [
    "STAR",
    "STAR Soccer Complex",
    "STAR Soccer Complex - Field 1",
    "STAR Soccer Complex - Field 2",
  ],
  "PAC Global": ["PAC Global"],
  "Galatzan Park": ["Galatzan Park"],
  "Centennial Commons": ["Centennial Commons"],
};

// Reverse lookup built once at module load. Keyed on the
// lowercased + trimmed alias so canonicalizeVenue can match
// case-insensitively without per-call work.
const REVERSE_LOOKUP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(VENUE_CANONICAL_MAP)) {
  for (const alias of aliases) {
    REVERSE_LOOKUP.set(alias.trim().toLowerCase(), canonical);
  }
}

// Soft-key fallback for aliases not yet in the map: collapse
// non-alphanumerics + lowercase. Catches simple-variant cases
// (extra whitespace, punctuation drift) without hand-listing.
function softKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
const SOFT_LOOKUP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(VENUE_CANONICAL_MAP)) {
  for (const alias of aliases) {
    SOFT_LOOKUP.set(softKey(alias), canonical);
  }
}

// Warn at most once per unknown input per process, same pattern
// as cityNormalization. Avoids log spam when a new venue shows
// up in many rows.
const warnedUnknown = new Set<string>();

// Returns the canonical venue key, or null if the input doesn't
// match any alias (direct or soft). Callers log + degrade
// gracefully on null; do not throw.
export function canonicalizeVenue(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = REVERSE_LOOKUP.get(trimmed.toLowerCase());
  if (direct) return direct;
  const soft = SOFT_LOOKUP.get(softKey(trimmed));
  if (soft) return soft;
  if (!warnedUnknown.has(trimmed)) {
    warnedUnknown.add(trimmed);
    console.warn(
      `[venueAliases] unknown venue "${trimmed}" — not in VENUE_CANONICAL_MAP. Add an alias to src/lib/venueAliases.ts.`,
    );
  }
  return null;
}
