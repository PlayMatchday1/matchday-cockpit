// Per-city color palette. Defined once here so the Cities → Users
// growth chart, future per-city dashboards, and any other multi-
// market visualization keep a consistent visual identity per market.
//
// Constraints when picking colors:
//   - Visible on cream/white card backgrounds (no near-white tones)
//   - Distinct from cockpit accent semantics (mint = active state,
//     coral = warning, gold = highlight). Colors below avoid those
//     exact tones to prevent confused signaling.
//   - Distinguishable when stacked adjacently (so we use different
//     hue families across the stack order, not a single-hue ramp).
//   - "Unknown" reads as muted/gray-ish so it doesn't compete for
//     attention with the canonical cities.

import { KNOWN_CITY_CODES } from "./cityNormalization";

export const UNKNOWN_CITY = "Unknown";

export const CITY_COLORS: Record<string, string> = {
  ATX: "#1f6f3f",   // deep evergreen — Austin is HQ + most users
  ATL: "#d97706",   // amber
  DFW: "#2563eb",   // blue
  HOU: "#b91c1c",   // rose-red
  OKC: "#6d28d9",   // purple
  SATX: "#be185d",  // magenta
  STL: "#0d9488",   // teal
  ELP: "#ca8a04",   // mustard
  [UNKNOWN_CITY]: "#94a3b8", // slate gray — distinctly "not a city"
};

// Display + stack order. Bottom-to-top in stacked-bar charts; that
// reads ATX at the base (largest cohort, anchors the visual) and
// Unknown at the top (most-likely-zero-or-small for any given period).
export const CITY_STACK_ORDER: readonly string[] = [
  ...KNOWN_CITY_CODES,
  UNKNOWN_CITY,
];

export function colorForCity(code: string): string {
  return CITY_COLORS[code] ?? CITY_COLORS[UNKNOWN_CITY];
}
