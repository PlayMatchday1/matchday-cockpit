// Hand-chosen spoken shorthand for the field titles shown on the Cancel Patterns
// chips. This is the ONE source of those labels — the Patterns view, the Numbers
// view, and the footer key all read from here, so they can never disagree and no
// view re-derives labels on its own.
//
// These are NOT initials. They are the codes the ops team says out loud ("that's
// the LBJ Sunday slot"), eyedropped from the approved screenshot. Deriving them
// from title initials (the regression this replaces) produced HCM / LEC / N / TH
// / WHF, which nobody uses.
//
// Keyed on the POST-normField canonical name — the value the shared mapper
// (mdapiMatchesRead → normField) stores as a slot's `field`, which is what
// getCancelHeatmap and the `fields` list both carry. normField already folds
// raw titles to canonicals: "The Hattrick L." → "The Hattrick", and both
// "Round Rock Multipurpose Complex" and "Stadium Field at Round Rock M.C." →
// "Round Rock" (so the two Round Rock fields share the RR chip, matching the
// rest of the app). fin_venue_aliases is a separate name-normalization table
// (alias → canonical_venue) with no short-code column, so the shorthand lives in
// code, not data.
//
// Fallback for anything unmapped: the first 4 characters of the canonical name,
// uppercased. Never a blank chip. Only Austin is covered below; other cities all
// hit the fallback until their shorthand is added here.
const FIELD_CODES: Record<string, string> = {
  "The Hattrick": "HT",
  "LBJ Early College High School": "LBJ",
  "Westlake HS Field 3": "WEST",
  NEMP: "NEMP",
  "Onion Creek": "OC",
  "Round Rock": "RR",
  "Hill Country Middle School": "HC",
  // Not in the approved 7, but an Austin field that shows in the Numbers grid.
  // "San Juan Diego" is the normField canonical for the SJD aliases; SJD is its
  // established spoken shorthand (carried over from the prior VENUE_CODE map), so
  // it wins over the "SAN" 4-char fallback.
  "San Juan Diego": "SJD",
};

// One field title → one code. Exact match first, then the 4-char fallback.
export function fieldCode(title: string): string {
  const t = (title ?? "").trim();
  const exact = FIELD_CODES[t];
  if (exact) return exact;
  return t.length >= 4 ? t.slice(0, 4).toUpperCase() : t.toUpperCase() || "—";
}

// Build the {title → code} lookup the Cancel Patterns card passes to both views.
export function fieldCodeMap(titles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of titles) out[t] = fieldCode(t);
  return out;
}
