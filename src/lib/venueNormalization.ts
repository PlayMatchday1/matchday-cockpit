// Resolve a Stripe match's raw `matchName (metadata)` value to a canonical
// venue name that lines up with fin_venues.venue_name.
//
// Pipeline, in order:
//   1. Strip leading non-letter / non-number characters (emoji prefixes like
//      "🏆 " or "⚽ ") using \p{L}\p{N} unicode classes — so accented venue
//      names with leading letters are NOT touched.
//   2. Strip trailing weekday suffix EXCEPT Sunday. "ATH Katy Tuesday" →
//      "ATH Katy"; "ATH Katy Sunday" stays as-is so it can resolve to its
//      own ($160) leg.
//   3. Apply DB aliases (fin_venue_aliases).
//   4. Cross-venue aliases — exact match (e.g. "Premier" → "San Juan Diego").
//   5. Internal-variant collapse — same venue's numbered/lettered/tournament
//      variants collapse to the bare name. Longest prefix wins (so
//      "ATH Katy Sunday" beats "ATH Katy", and "Soccer Central 4A" beats
//      anything starting with "Soccer").

const WEEKDAY_SUFFIX_RX =
  /\s+(Mon|Mondays?|Tue|Tues?|Tuesdays?|Wed|Wednesdays?|Thu|Thurs?|Thursdays?|Fri|Fridays?|Sat|Saturdays?)$/i;

// Cross-venue exact aliases. Different raw name → different canonical venue.
const CROSS_VENUE_ALIASES: Record<string, string> = {
  Premier: "San Juan Diego",
  SJD: "San Juan Diego",
};

// Internal-variant collapses. The raw name STARTS WITH the prefix, optionally
// followed by a space/dash/digit/letter, and resolves to the canonical name.
// Longer prefixes are checked first.
const INTERNAL_PREFIX_RULES: Array<{ prefix: string; canonical: string }> = [
  // Longest first so "ATH Katy Sunday" wins over "ATH Katy".
  { prefix: "ATH Katy Sunday", canonical: "ATH Katy Sunday" },
  { prefix: "ATH Pearland Tournament", canonical: "ATH Pearland" },
  { prefix: "ATH Pearland Tourney", canonical: "ATH Pearland" },
  { prefix: "Katy Intl", canonical: "KISC" },
  { prefix: "ATH Pearland", canonical: "ATH Pearland" },
  { prefix: "ATH Katy", canonical: "ATH Katy" },
  { prefix: "Soccer Central", canonical: "Soccer Central" },
  { prefix: "Onion Creek", canonical: "Onion Creek" },
  { prefix: "Hammond Park", canonical: "Hammond Park" },
  { prefix: "Round Rock", canonical: "Round Rock" },
  { prefix: "Stony Point", canonical: "Stony Point" },
  { prefix: "PAC Global", canonical: "PAC Global" },
  { prefix: "Bicentennial", canonical: "Bicentennial" },
  { prefix: "Scissortail", canonical: "Scissortail" },
  { prefix: "PRUMC", canonical: "PRUMC" },
  { prefix: "NEMP", canonical: "NEMP" },
  { prefix: "STAR", canonical: "STAR" },
  { prefix: "KISC", canonical: "KISC" },
];

export type VenueResolution = {
  original: string;
  canonical: string | null;
};

function stripLeadingEmoji(s: string): string {
  // Strip leading characters that are NOT letters or numbers (any script).
  // Catches "🏆 ", "⚽ ", and any leading punctuation. Trims whitespace after.
  return s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function stripWeekdaySuffix(s: string): string {
  // KEEP Sunday — ATH Katy Sunday is its own billing leg.
  return s.replace(WEEKDAY_SUFFIX_RX, "").trim();
}

function matchesPrefix(name: string, prefix: string): boolean {
  if (name === prefix) return true;
  if (!name.startsWith(prefix)) return false;
  const next = name.charAt(prefix.length);
  // Must be followed by separator (space, dash, slash) or digit/letter.
  return next === " " || next === "-" || next === "/" || /[0-9A-Za-z]/.test(next);
}

export function normalizeMatchName(
  raw: string | null | undefined,
  aliases: Map<string, string>,
): VenueResolution {
  const original = (raw ?? "").trim();
  if (!original) return { original, canonical: null };

  // 1. Strip emoji / leading punctuation.
  let n = stripLeadingEmoji(original);
  if (!n) return { original, canonical: null };

  // 2. Strip weekday suffix (NOT Sunday).
  n = stripWeekdaySuffix(n);

  // 3. DB aliases — exact match first.
  const dbAlias = aliases.get(n);
  if (dbAlias) return { original, canonical: dbAlias };

  // 4. Cross-venue aliases — exact match.
  const cross = CROSS_VENUE_ALIASES[n];
  if (cross) return { original, canonical: cross };

  // 5. Internal-variant collapse — longest prefix wins.
  for (const { prefix, canonical } of INTERNAL_PREFIX_RULES) {
    if (matchesPrefix(n, prefix)) return { original, canonical };
  }

  // 6. Fall through: the cleaned name is the canonical.
  return { original, canonical: n };
}
