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

// "Foo (Bar)" → "Foo" — trailing parenthetical block.
const PAREN_SUFFIX_RX = /\s*\([^)]*\)\s*$/;

// Trailing dashes / em-dashes / whitespace.
const TRAILING_PUNCT_RX = /[\s\-–—]+$/;

// "X - Outdoor Field N" → "X Outdoor"; same for Indoor. Preserves the
// qualifier because Outdoor and Indoor are separate venues.
const OUTDOOR_INDOOR_FIELD_RX =
  /\s*[-–—]\s*(Outdoor|Indoor)\s+Field\s+\S+\s*$/i;

// "X - Field N" or "X Field N" → "X". Bare field-number strip with optional
// dash. Runs only when the Outdoor/Indoor pattern doesn't match.
const BARE_FIELD_RX = /\s*[-–—]?\s*Field\s+\S+\s*$/i;

// "Premier match at X" → recurse on X. Matches case-insensitively.
const PREMIER_MATCH_AT_RX = /^Premier\s+match\s+at\s+(.+)$/i;

// Cross-venue exact aliases. Different raw name → different canonical venue.
const CROSS_VENUE_ALIASES: Record<string, string> = {
  Premier: "San Juan Diego",
  SJD: "San Juan Diego",
  "Katy International Sports Complex": "KISC",
};

// Internal-variant collapses. The raw name STARTS WITH the prefix, optionally
// followed by a space/dash/digit/letter, and resolves to the canonical name.
// Longer prefixes are checked first.
const INTERNAL_PREFIX_RULES: Array<{ prefix: string; canonical: string }> = [
  // Longest first so "ATH Katy Sunday" wins over "ATH Katy".
  { prefix: "ATH Katy Sunday", canonical: "ATH Katy Sunday" },
  { prefix: "ATH Pearland Tournament", canonical: "ATH Pearland" },
  { prefix: "ATH Pearland Tourney", canonical: "ATH Pearland" },
  { prefix: "Katy International Sports Complex", canonical: "KISC" },
  { prefix: "Katy International", canonical: "KISC" },
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

function stripTrailingPunctuation(s: string): string {
  return s.replace(TRAILING_PUNCT_RX, "").trim();
}

function stripParentheticalSuffix(s: string): string {
  return s.replace(PAREN_SUFFIX_RX, "").trim();
}

function stripFieldSuffix(s: string): string {
  // Outdoor/Indoor with field number → preserve qualifier.
  const withQualifier = s.replace(OUTDOOR_INDOOR_FIELD_RX, " $1");
  if (withQualifier !== s) return withQualifier.trim();
  // Bare field number → strip.
  return s.replace(BARE_FIELD_RX, "").trim();
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

function resolveCanonical(
  rawInput: string,
  aliases: Map<string, string>,
  depth: number = 0,
): string | null {
  if (depth > 5) return rawInput; // recursion safety net

  // 1. Strip emoji / leading punctuation.
  let n = stripLeadingEmoji(rawInput);
  if (!n) return null;

  // 2. Strip trailing punctuation (e.g. "Foo -" → "Foo").
  n = stripTrailingPunctuation(n);

  // 3. Strip trailing parenthetical (e.g. "Foo (Leander)" → "Foo").
  n = stripParentheticalSuffix(n);

  // 4. Strip field-number suffix; preserve Outdoor/Indoor qualifier.
  n = stripFieldSuffix(n);

  // 5. Strip weekday suffix (NOT Sunday).
  n = stripWeekdaySuffix(n);

  if (!n) return null;

  // 6. "Premier match at X" → recurse on X with the same alias map.
  const premier = n.match(PREMIER_MATCH_AT_RX);
  if (premier) return resolveCanonical(premier[1], aliases, depth + 1);

  // 7. Cross-venue aliases — exact match.
  const cross = CROSS_VENUE_ALIASES[n];
  if (cross) return cross;

  // 8. DB aliases — exact match (user-overridable safety net).
  const dbAlias = aliases.get(n);
  if (dbAlias) return dbAlias;

  // 9. Internal-variant collapse — longest prefix wins.
  for (const { prefix, canonical } of INTERNAL_PREFIX_RULES) {
    if (matchesPrefix(n, prefix)) return canonical;
  }

  // 10. Fall through: the cleaned name is the canonical.
  return n;
}

export function normalizeMatchName(
  raw: string | null | undefined,
  aliases: Map<string, string>,
): VenueResolution {
  const original = (raw ?? "").trim();
  if (!original) return { original, canonical: null };
  return { original, canonical: resolveCanonical(original, aliases) };
}
