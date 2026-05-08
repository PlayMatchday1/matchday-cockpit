// Stable per-field colors for the First Match by Field section. A
// 12-color palette is hashed by field name so the same field always
// gets the same color across all city sub-sections (San Juan Diego is
// always the same green, ATH Pearland is always the same red, etc.).
//
// Constraints when picking colors — same as cityColors.ts:
//   - Visible on cream/white card backgrounds (no near-white tones)
//   - Distinct from cockpit accent semantics (mint=active, coral=warning)
//   - Distinguishable when stacked adjacently (mix hue families)
// Most cities have 2-4 distinct fields so the chance of two adjacent
// stack segments getting the same hash slot is low. If it happens,
// rename the field in normField (rare — only when a new field is
// introduced) or extend this palette.

const PALETTE: readonly string[] = [
  "#1f6f3f", //  0 deep evergreen (San Juan Diego — anchor color, ATX)
  "#b91c1c", //  1 rose-red (ATH Pearland — anchor color, HOU)
  "#2563eb", //  2 blue
  "#ca8a04", //  3 mustard
  "#6d28d9", //  4 purple
  "#0d9488", //  5 teal
  "#be185d", //  6 magenta
  "#d97706", //  7 amber
  "#475569", //  8 slate
  "#7c2d12", //  9 brown
  "#0369a1", // 10 dark blue
  "#854d0e", // 11 ochre
];

// Hand-pinned slots for marquee fields so they get the colors above
// regardless of palette additions. Matches user spec ("SJD always
// green-X, ATH Pearland always red-Y").
const FIELD_PALETTE_PIN: Record<string, number> = {
  "San Juan Diego": 0,
  "ATH Pearland": 1,
  "Soccer Central": 5,
  "ATH Katy": 7,
  "Lou Fusz Outdoor": 4,
  "Lou Fusz Indoor": 10,
  PRUMC: 6,
  "The Hattrick": 9,
  "Galatzan Park": 3,
  "Scissortail Park": 2,
  "Bicentennial Park": 11,
  "Round Rock": 8,
};

function hashIdx(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

export function colorForField(field: string): string {
  const pinned = FIELD_PALETTE_PIN[field];
  if (pinned !== undefined) return PALETTE[pinned];
  return PALETTE[hashIdx(field, PALETTE.length)];
}

// Pick a readable text color (white vs deep-green) given a background
// color from the palette. Uses simple luminance approximation. For
// the 12-color palette, dark slots return white-on-color and lighter
// slots return ink-on-color. Only the "ochre" / "amber" slots are
// borderline; the threshold below puts them on white-text consistently.
export function textOnFieldColor(bgHex: string): string {
  const r = parseInt(bgHex.slice(1, 3), 16);
  const g = parseInt(bgHex.slice(3, 5), 16);
  const b = parseInt(bgHex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0a1a10" : "#ffffff";
}
