// The single canonical venue resolver — two outputs per raw string.
//
// This replaces the three matchers that disagreed in production:
//   1. Growth's raw `field_title` grouping (no normalization at all)
//   2. Finance's `normField()` (substring rules, no category, wrong on a few)
//   3. fin_revenue's `fin_venue_aliases` / `canonVenue()` path (DB aliases only)
//
// It returns, for any raw venue string OR mdapi field_title OR Stripe
// metadata.matchName:
//
//   canonicalVenue — the fin_venues identity after spelling/field-suffix
//                    aliasing. One string per physical pitch.
//   city           — fin_venues.city for that canonical (or a fallback for the
//                    handful of canonicals with no fin_venues row), else null.
//   category       — 'event' | 'regular', derived from the string's OWN event
//                    markers (Tourney / Combine / World Cup / …), NEVER from
//                    the pitch. A tournament at NEMP is an event; NEMP is not.
//
// Two identity calls, made deliberately and asserted by tests:
//   - Hattrick Lakeline ("Hattrick" / "The Hattrick" / "The Hattrick L.") and
//     Hattrick Tomball ("Hattrick T." / "Hattrick Tomball" / "The Hattrick T.")
//     are DIFFERENT venues in different cities (Austin vs Houston). normField()
//     merged them; we do not.
//   - "Soccer Central World Cup Tournament" is an event and gets a city
//     (San Antonio, via the Soccer Central identity) instead of resolving
//     nowhere.

export type VenueCategory = "regular" | "event";

export type ResolvedVenue = {
  /** Canonical fin_venues.venue_name after aliasing (or the trimmed input when unknown). */
  canonicalVenue: string;
  /** Resolved city, or null when the canonical maps to no known market. */
  city: string | null;
  /** From the raw string's own event markers, independent of the pitch. */
  category: VenueCategory;
};

// Category is decided by ONE rule: does the raw string contain an event-activity
// marker? Nothing else — not the pitch, not whether an activity name wraps a
// venue. This is the rule that separates two identically-shaped strings:
//
//   "MatchDay Combine at Lou Fusz"     → "combine" fires   → event
//   "Premier Match at Soccer Central"  → no marker fires   → regular
//
// The markers below are ACTIVITY names that only ever denote a special event.
// Words that look activity-ish but are venue/tier/format qualifiers are
// deliberately NOT markers: "Match", "Premier", "Complex", "Stadium", "Field",
// "Multipurpose", "Sports Complex", "at". A tournament held at NEMP is an event;
// NEMP is not. Matched against the raw string (field_title or metadata.matchName)
// before canonicalization, word-boundaried so "camp" ≠ "Scamp".
const EVENT_MARKERS =
  /\b(tourney|tournament|tournaments|combine|world\s*cup|showcase|showdown|clinic|camp|invitational|special\s*events?)\b/i;

export function venueCategory(raw: string | null | undefined): VenueCategory {
  return raw && EVENT_MARKERS.test(raw) ? "event" : "regular";
}

// Ordered canonicalization rules. First match wins, so the order encodes the
// disambiguations: Katy before Pearland (both "ATH …"), Hattrick Tomball before
// generic Hattrick, Lou Fusz Indoor before the Lou Fusz fallback.
type Rule = { re: RegExp; canonical: string };
const RULES: Rule[] = [
  { re: /westlake|west\s*lake/i, canonical: "Westlake" },
  { re: /san juan diego|premier at sjd/i, canonical: "San Juan Diego" },
  { re: /soccer central/i, canonical: "Soccer Central" },
  { re: /ath katy/i, canonical: "ATH Katy" },
  { re: /ath pearland/i, canonical: "ATH Pearland" },
  { re: /nemp|north east metropolitan/i, canonical: "NEMP" },
  { re: /round rock/i, canonical: "Round Rock" },
  // Round Rock abbreviations from the pre-canonical era (e.g. "Special Events at
  // RR", "RRMC F8", "RR F8"). Word-boundaried so "RR"/"RRMC" only match as their
  // own token. After the full-spelling /round rock/ rule, so it only catches the
  // abbreviated forms.
  { re: /\brrmc\b|\brr\b/i, canonical: "Round Rock" },
  // Lou Fusz Indoor: the Training Center / TC / Indoor variants.
  { re: /lou fusz.*(indoor|training center|\btc\b)/i, canonical: "Lou Fusz Indoor" },
  { re: /lou fusz/i, canonical: "Lou Fusz Outdoor" },
  { re: /onion creek/i, canonical: "Onion Creek" },
  // Tomball BEFORE generic Hattrick. "The Hattrick T." or "Hattrick Tomball".
  { re: /hattrick.*tomball|tomball.*hattrick|hattrick\s+t\.?\b/i, canonical: "Hattrick T." },
  { re: /hattrick/i, canonical: "Hattrick" },
  { re: /lbj early college/i, canonical: "LBJ Early College High School" },
  { re: /hill country/i, canonical: "Hill Country Middle School" },
  { re: /parmer/i, canonical: "Parmer" },
  { re: /crossbar rowlett/i, canonical: "Crossbar Rowlett" },
  { re: /galatzan/i, canonical: "Galatzan Park" },
  { re: /scissortail/i, canonical: "Scissortail Park" },
  { re: /bicentennial/i, canonical: "Bicentennial Park" },
  { re: /majestic/i, canonical: "Majestic Gardens" },
  { re: /pac ?global/i, canonical: "PAC Global" },
  { re: /star soccer|^star$/i, canonical: "STAR" },
  { re: /stony point/i, canonical: "Stony Point" },
  { re: /katy international/i, canonical: "KISC (Katy Intl)" },
  { re: /centennial commons/i, canonical: "Centennial Commons" },
  { re: /carroll/i, canonical: "Carroll Senior HS" },
  { re: /prumc/i, canonical: "PRUMC" },
  { re: /hammond park/i, canonical: "Hammond Park" },
  { re: /lowell h\.? strike/i, canonical: "Lowell H. Strike M.S." },
  { re: /helix park/i, canonical: "Helix Park" },
];

export function canonicalVenueName(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  for (const r of RULES) if (r.re.test(t)) return r.canonical;
  return t;
}

// City for canonicals with no fin_venues row (or as a defensive fallback when
// the venues list isn't threaded through). Every other canonical resolves via
// the fin_venues (venue_name → city) map passed to resolveVenue.
export const CANONICAL_CITY_FALLBACK: Record<string, string> = {
  Westlake: "Austin",
  "San Juan Diego": "Austin",
  "Soccer Central": "San Antonio",
  "ATH Katy": "Houston",
  "ATH Pearland": "Houston",
  NEMP: "Austin",
  "Round Rock": "Austin",
  "Lou Fusz Indoor": "St. Louis",
  "Lou Fusz Outdoor": "St. Louis",
  "Onion Creek": "Austin",
  "Hattrick T.": "Houston",
  Hattrick: "Austin",
  "LBJ Early College High School": "Austin",
  "Hill Country Middle School": "Austin",
  Parmer: "Austin",
  "Crossbar Rowlett": "Dallas",
  "Galatzan Park": "El Paso",
  "Scissortail Park": "OKC",
  "Bicentennial Park": "Dallas",
  "Majestic Gardens": "Dallas",
  "PAC Global": "Houston",
  STAR: "San Antonio",
  "Stony Point": "Austin",
  "KISC (Katy Intl)": "Houston",
  "Centennial Commons": "St. Louis",
  "Carroll Senior HS": "Dallas",
  PRUMC: "Atlanta",
  "Hammond Park": "Atlanta",
  "Lowell H. Strike M.S.": "Dallas",
  "Helix Park": "Houston",
};

/**
 * Resolve a raw venue string / field_title / matchName to its canonical
 * identity, city, and category. `cityByCanonical` is the fin_venues
 * (venue_name → city) map — the source of truth for city; the code-level
 * fallback only fills canonicals that have no fin_venues row.
 */
export function resolveVenue(
  raw: string | null | undefined,
  cityByCanonical?: ReadonlyMap<string, string>,
): ResolvedVenue {
  const category = venueCategory(raw);
  const canonicalVenue = canonicalVenueName(raw);
  if (!canonicalVenue) return { canonicalVenue: "", city: null, category };
  const city =
    cityByCanonical?.get(canonicalVenue) ??
    CANONICAL_CITY_FALLBACK[canonicalVenue] ??
    null;
  return { canonicalVenue, city, category };
}
