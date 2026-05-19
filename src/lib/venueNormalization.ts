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

// The connector before the day can be plain whitespace OR a hyphen with
// optional surrounding whitespace — matches " Thursday", " - Thursday",
// "-Thursday", and "- Thursday". Sunday is intentionally absent from the
// alternation so "ATH Katy Sunday" / "ATH Katy - Sunday" stay intact.
const WEEKDAY_SUFFIX_RX =
  /(?:\s*[-–—]\s*|\s+)(Mon|Mondays?|Tue|Tues?|Tuesdays?|Wed|Wednesdays?|Thu|Thurs?|Thursdays?|Fri|Fridays?|Sat|Saturdays?)$/i;

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
// Canonicals here MUST match fin_venues.venue_name exactly so the
// per-venue revenue lookup on the city cards finds them.
//
// Many of these "Tourney …" / "… at X" / "… Catholic High School" entries
// were caught for free by the prior substring matcher (raw field happened
// to contain the venue's canonical name). Once the substring matcher was
// replaced by the prefix-based normalizer, leading-prefix names like
// "Tourney ATH Pearland" stopped resolving — INTERNAL_PREFIX_RULES is
// startsWith-only. Add them here as exact-match aliases so every distinct
// field_title currently in mdapi_matches resolves the way the substring
// matcher used to (verified by enumerating distinct field_title values
// across all cities — see fix-up commit notes).
const CROSS_VENUE_ALIASES: Record<string, string> = {
  Premier: "San Juan Diego",
  SJD: "San Juan Diego",
  "Premier at SJD": "San Juan Diego",
  "Katy International Sports Complex": "KISC (Katy Intl)",
  "The Hattrick": "Hattrick",
  "Tourney ATH Pearland": "ATH Pearland",
  "Tourney at Soccer Central": "Soccer Central",
  "San Juan Diego Catholic High School": "San Juan Diego",
  "Stadium Field at Round Rock M.C.": "Round Rock",
  "North East Metropolitan Park": "NEMP",
  // Lou Fusz facility — fin_venues splits the same physical site into
  // separate Indoor / Outdoor rows because they're billed differently.
  // mdapi field_title is the user-facing facility name; the suffix
  // ("Athletic Complex" vs "Athletic Training Center") disambiguates.
  // Source of truth: schedule operator (no future Indoor matches —
  // historic Q1-only — but the alias keeps backward-looking reports
  // resolving correctly).
  "Lou Fusz Athletic Complex": "Lou Fusz Outdoor",
  "Lou Fusz Athletic Training Center": "Lou Fusz Indoor",
  // No-trailing-token variants the stripFieldSuffix regexes don't
  // catch (OUTDOOR_INDOOR_FIELD_RX / BARE_FIELD_RX both require
  // \S+ after "Field"). Listed as exact-match aliases so Stripe
  // charges whose metadata is one of these collapse to the
  // canonical fin_venues row instead of producing stale variants.
  "Lou Fusz - Outdoor Field": "Lou Fusz Outdoor",
  "Lou Fusz - Indoor Field": "Lou Fusz Indoor",
  "Lou Fusz - Indoor": "Lou Fusz Indoor",
  "Lou Fusz TC Indoor Field": "Lou Fusz Indoor",
  "MatchDay Combine at Lou Fusz": "Lou Fusz Outdoor",
};

// Internal-variant collapses. The raw name STARTS WITH the prefix, optionally
// followed by a space/dash/digit/letter, and resolves to the canonical name.
// Longer prefixes are checked first.
// Internal-variant collapses. The canonical name on the right MUST match
// fin_venues.venue_name exactly so DPP revenue lands on the venue's row in
// the City P&L card instead of the "Other field DPP" bucket.
const INTERNAL_PREFIX_RULES: Array<{ prefix: string; canonical: string }> = [
  // Longest first so "ATH Katy Sunday" wins over "ATH Katy".
  { prefix: "ATH Katy Sunday", canonical: "ATH Katy Sunday" },
  { prefix: "ATH Pearland Tournament", canonical: "ATH Pearland" },
  { prefix: "ATH Pearland Tourney", canonical: "ATH Pearland" },
  { prefix: "Katy International Sports Complex", canonical: "KISC (Katy Intl)" },
  { prefix: "Carroll Senior High School", canonical: "Carroll Senior HS" },
  { prefix: "Katy International", canonical: "KISC (Katy Intl)" },
  { prefix: "Carroll Senior HS", canonical: "Carroll Senior HS" },
  { prefix: "Katy Intl", canonical: "KISC (Katy Intl)" },
  { prefix: "ATH Pearland", canonical: "ATH Pearland" },
  { prefix: "ATH Katy", canonical: "ATH Katy" },
  { prefix: "Soccer Central", canonical: "Soccer Central" },
  { prefix: "Onion Creek", canonical: "Onion Creek" },
  { prefix: "Hammond Park", canonical: "Hammond Park" },
  { prefix: "Round Rock", canonical: "Round Rock" },
  { prefix: "Stony Point", canonical: "Stony Point" },
  { prefix: "PAC Global", canonical: "PAC Global" },
  { prefix: "Bicentennial", canonical: "Bicentennial Park" },
  { prefix: "Scissortail", canonical: "Scissortail Park" },
  { prefix: "PRUMC", canonical: "PRUMC" },
  { prefix: "NEMP", canonical: "NEMP" },
  { prefix: "STAR", canonical: "STAR" },
  { prefix: "KISC", canonical: "KISC (Katy Intl)" },
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
  // Case-insensitive — raw matchNames sometimes arrive ALL-CAPS
  // (e.g. "PAC GLOBAL FIELD 5") and we want them to collapse to the
  // canonical-cased fin_venues.venue_name.
  const nameLc = name.toLowerCase();
  const prefixLc = prefix.toLowerCase();
  if (nameLc === prefixLc) return true;
  if (!nameLc.startsWith(prefixLc)) return false;
  const next = name.charAt(prefix.length);
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

// =====================================================================
// Field-title → fin_venues.id resolver. Single source of truth for the
// "which venue does this match's field_title belong to" lookup —
// previously reinvented as substring-matchers in matchPnL.ts,
// projectionsStats.ts, and financeStats.ts. Those all failed for
// synonym pairs like "Katy International Sports Complex" (mdapi field)
// vs "KISC (Katy Intl)" (fin_venues row): no shared substring → null.
//
// Pipeline: normalizeMatchName(field, aliases) → canonical name →
// exact match against fin_venues.venue_name. Same canonical rules
// (CROSS_VENUE_ALIASES + INTERNAL_PREFIX_RULES + DB aliases) the
// CSV/Stripe import path has used since Phase 2, so identity is
// consistent end-to-end.
//
// Returns a Map keyed by the original raw field strings → venue.id.
// Unresolvable fields (no canonical, or canonical not in fin_venues)
// are absent from the map — callers downstream check for this and
// surface as "missing venue" / "no cost set", matching the prior
// substring-matcher behavior.
// =====================================================================

// =====================================================================
// Day-of-week aware sibling lookup. fin_venues encodes split-rate
// venues as separate rows where the qualified row's venue_name is the
// base name + " " + day-of-week (e.g. "ATH Katy" + "ATH Katy Sunday",
// $140 weekday vs $160 Sunday). Generic — the same shape works for any
// future split-rate venue that follows the convention.
//
// Pipeline at the call site:
//   1. buildFieldToVenueIdMap → base venueId (from field_title)
//   2. resolveVenueForMatch(baseVenueId, matchStart) → final venueId +
//      cost. If a "<base name> <DayOfWeek>" sibling exists AND the
//      match's start day matches, return the sibling. Otherwise base.
//
// Cost-fallback: if the sibling exists but its cost_per_match is null
// (data not entered yet), return the SIBLING's id (so bucketing keeps
// the rate-tier separation) but the BASE venue's cost (so callers
// don't show "NO COST SET" for what's structurally just an unfilled
// rate row). Logs a warning so the operator notices the missing data.
// =====================================================================

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type DayAwareVenueResolution = {
  venueId: number;
  // Cost for this match — already day-aware. Use this instead of
  // re-reading venue.cost_per_match by id. Null only when both the
  // resolved venue AND the base venue (in cost-fallback case) lack a
  // cost_per_match entry.
  cost: number | null;
  // Set to the BASE venue's id when the day-of-week swap fired but
  // the sibling's cost was null and we fell back to the base rate.
  // Display layers can show "ATH Katy Sunday — using ATH Katy rate"
  // when this is non-null.
  costFellBackTo: number | null;
};

export function resolveVenueForMatch(
  baseVenueId: number,
  matchStart: Date,
  venues: { id: number; venue_name: string; cost_per_match: number | null }[],
): DayAwareVenueResolution {
  const base = venues.find((v) => v.id === baseVenueId);
  if (!base) {
    return { venueId: baseVenueId, cost: null, costFellBackTo: null };
  }
  const dayName = DOW_NAMES[matchStart.getDay()];
  const siblingName = `${base.venue_name} ${dayName}`;
  const sibling = venues.find((v) => v.venue_name === siblingName);
  if (!sibling) {
    return {
      venueId: base.id,
      cost: base.cost_per_match,
      costFellBackTo: null,
    };
  }
  if (sibling.cost_per_match != null) {
    return {
      venueId: sibling.id,
      cost: sibling.cost_per_match,
      costFellBackTo: null,
    };
  }
  // Sibling exists but cost not set — keep sibling for bucketing,
  // fall back to base rate for the cost value, log so operator sees
  // the gap.
  console.warn(
    `[resolveVenueForMatch] ${dayName} sibling "${siblingName}" (id ${sibling.id}) exists in fin_venues but cost_per_match is null. Falling back to base "${base.venue_name}" rate ($${base.cost_per_match ?? "null"}). Set the cost on venue id ${sibling.id} in Field Costs admin to use the correct rate.`,
  );
  return {
    venueId: sibling.id,
    cost: base.cost_per_match,
    costFellBackTo: base.id,
  };
}

// PR-E: field_id → fin_venues.id resolver. Same role as
// buildFieldToVenueIdMap (above) but keyed on the stable numeric
// mdapi field_id rather than canonicalizing field_title strings.
// Called by all internal Finance read paths (Field Ranking, Match
// P&L, Projections, member-spot index). venueAliases / normalize-
// MatchName remain the Stripe boundary's name-based path.
export function buildFieldIdToVenueIdMap(
  fieldIds: Set<number>,
  venueFields: Map<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const fieldId of fieldIds) {
    const venueId = venueFields.get(fieldId);
    if (venueId != null) out.set(fieldId, venueId);
  }
  return out;
}

export function buildFieldToVenueIdMap(
  fields: Set<string>,
  venues: { id: number; venue_name: string }[],
  aliases: Map<string, string>,
): Map<string, number> {
  // venue_name → id. fin_venues.venue_name values are unique within a
  // city, but the canonical names from venueNormalization are global,
  // so multiple venues with the same canonical (shouldn't happen, but
  // defensive) would race; first-write-wins. Tie-break warning lives
  // here rather than at every call site.
  const byCanonical = new Map<string, number>();
  for (const v of venues) {
    if (!byCanonical.has(v.venue_name)) {
      byCanonical.set(v.venue_name, v.id);
    }
  }
  const out = new Map<string, number>();
  for (const field of fields) {
    const canonical = normalizeMatchName(field, aliases).canonical;
    if (!canonical) continue;
    const id = byCanonical.get(canonical);
    if (id != null) out.set(field, id);
  }
  return out;
}
