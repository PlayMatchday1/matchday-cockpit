/* VENUES & FIELDS — the grouping, the totals and the two warning classes, as pure functions.
 *
 * WHY A MODEL FILE AND NOT JSX. The page's whole claim is that a venue's numbers ARE its fields'
 * numbers added up. That claim is worth asserting, and an assertion can only be written against
 * something callable. Everything here takes the payload the existing /api/admin/fields route
 * already returns and returns plain data; the view renders it and computes nothing.
 *
 * ── THE GROUPING IS SOUND BY CONSTRAINT, NOT BY LUCK ──────────────────────────────────────────
 * fin_venue_fields.mdapi_field_id is `bigint NOT NULL UNIQUE` (migration 0041:36). A field id
 * therefore cannot appear under two venues, which is what makes a nested list a legitimate shape
 * for this data rather than a lossy one. Measured 2026-08-29: 44 links, 0 duplicates.
 *
 * ── TWO WARNING CLASSES, AND THEY SAY DIFFERENT THINGS ────────────────────────────────────────
 *   UNMAPPED         no fin_venue_fields row. No cost, no revenue attribution, invisible to every
 *                    finance page. 36 field ids, 461 live matches, 2,827 spots, $18,818 all-time.
 *   MAPPED, NO RATE  attributed to a venue that bills at nothing. A venue is in this class when
 *                    EITHER rate column is null AND it actually has a field on it — the harm is
 *                    "a field's money is attributed and costed at zero", which needs a field.
 *                    Six today: PAC Global, Helix Park, PARMER Stadium (both columns null) and
 *                    San Juan Diego, Hattrick, Hattrick T. (null on one side only). PARMER is
 *                    ACTIVE with revenue, which is why the second class is not a footnote.
 *
 * A VENUE WITH NO FIELDS IS NOT IN EITHER CLASS. #23 ATH Katy Sunday and #53 Soccer Central
 * Tournament have no links, so nothing is attributed to them and nothing is billed at nothing.
 * They still carry the rate-disagreement marker, which is about the row itself.
 *
 * ── THE RATE SHOWN IS cost_per_match ──────────────────────────────────────────────────────────
 * Field Economics reads that column, so the page shows what the money actually uses. Where the
 * two columns differ they are BOTH shown with a marker; nothing is picked silently and nothing is
 * averaged. Seven disagree today, and Westlake (135 vs 114) is unruled.
 */

import type { FieldIdRow, VenueOption } from "./fieldIdAdmin";

export type FieldTag = "counts as 2" | "renamed" | "special event";

export type VenueField = {
  fieldId: number;
  title: string | null;
  address: string | null;
  city: string | null;
  tags: FieldTag[];
  liveMatches: number;
  cancelledMatches: number;
  upcomingMatches: number;
  spots: number;
  revenue: number;
  /** yyyy-mm-dd → yyyy-mm-dd over LIVE matches, or null when the field has none. */
  span: string | null;
};

export type VenueBlock = {
  venueId: number;
  name: string;
  city: string | null;
  isActive: boolean;
  /** cost_per_match — the column Field Economics reads. Null is a real state, not a zero. */
  rate: number | null;
  /** per_match_rate, carried ONLY so a disagreement can show both. */
  altRate: number | null;
  rateDisagrees: boolean;
  /** Attributed to a venue that bills at nothing. See the header. */
  ratelessWarning: boolean;
  fields: VenueField[];
  fieldCount: number;
  liveMatches: number;
  cancelledMatches: number;
  spots: number;
  revenue: number;
};

export type UnattributedBlock = {
  fields: VenueField[];
  fieldCount: number;
  liveMatches: number;
  cancelledMatches: number;
  spots: number;
  revenue: number;
  /** Unmapped fields with matches still to come — they are about to generate more. */
  upcoming: { fieldId: number; title: string | null; upcomingMatches: number }[];
};

export type VenuesView = {
  unattributed: UnattributedBlock;
  venues: VenueBlock[];
  rateless: VenueBlock[];
  disagreements: VenueBlock[];
};

/* THE SPAN IS OVER LIVE MATCHES ONLY, which is what firstMatch/lastMatch already hold. A single
 * date renders as itself rather than "X → X". */
function spanOf(f: FieldIdRow): string | null {
  if (!f.firstMatch) return null;
  return f.lastMatch && f.lastMatch !== f.firstMatch ? `${f.firstMatch} → ${f.lastMatch}` : f.firstMatch;
}

/** EVERY TAG IS DERIVED, never a list of ids.
 *
 *  counts as 2     fin_venue_fields.counts_as_regular_play. Four fields hold it — 22, 199, 1552
 *                  and 496 Tourney at Lou Fusz, which the mockup missed. An unmapped field cannot
 *                  carry it: the flag lives on the link.
 *  renamed         titleVariants > 1 — the title on this field id has changed upstream at least
 *                  once. Exactly one field in the estate: 1024, The Hattrick.
 *  special event   liveMatches > billableLive. billableLive counts the matches whose OWN title is
 *                  not an event schedule, under the same isEventSchedule test financeCosts
 *                  applies — so this reads the cost model's own opinion rather than a second one.
 *                  19 fields.
 *
 *  THERE IS NO "2 PITCHES" TAG. It was withdrawn: there is no column meaning "this venue has two
 *  pitches side by side", counting fields does not mean that, and re-stating a field-level flag on
 *  the venue says it in the wrong place. The field-level "counts as 2" carries the meaning.
 */
export function tagsFor(f: FieldIdRow): FieldTag[] {
  const t: FieldTag[] = [];
  if (f.mapping?.countsAsRegularPlay) t.push("counts as 2");
  if (f.titleVariants > 1) t.push("renamed");
  if (f.liveMatches > f.billableLive) t.push("special event");
  return t;
}

function toVenueField(f: FieldIdRow): VenueField {
  return {
    fieldId: f.fieldId,
    title: f.title,
    address: f.address,
    city: f.city,
    tags: tagsFor(f),
    liveMatches: f.liveMatches,
    cancelledMatches: f.cancelledMatches,
    upcomingMatches: f.upcomingMatches,
    spots: f.dppSpots,
    revenue: f.dppRevenue,
    span: spanOf(f),
  };
}

const sum = <T,>(xs: T[], k: (x: T) => number) => xs.reduce((a, x) => a + k(x), 0);

/** Null on EITHER side is a missing rate. A venue that bills but reports no rate is the same
 *  animal as one with neither column set. */
const rateMissing = (v: VenueOption) => v.perMatchRate == null || v.costPerMatch == null;

/** DISAGREEMENT IS ABOUT THE ROW, not about whether a field hangs off it — so it is computed
 *  independently of fieldCount and marks all seven, including #23 with no fields. Null vs a
 *  number is a disagreement; null vs null is not. */
const rateDisagrees = (v: VenueOption) => Number(v.perMatchRate ?? NaN) !== Number(v.costPerMatch ?? NaN)
  && !(v.perMatchRate == null && v.costPerMatch == null);

export function buildVenuesView(fields: FieldIdRow[], venues: VenueOption[]): VenuesView {
  const mapped = new Map<number, FieldIdRow[]>();
  const loose: FieldIdRow[] = [];
  for (const f of fields) {
    if (!f.mapping) { loose.push(f); continue; }
    const a = mapped.get(f.mapping.venueId) ?? [];
    a.push(f);
    mapped.set(f.mapping.venueId, a);
  }

  const blocks: VenueBlock[] = venues.map((v) => {
    const rows = (mapped.get(v.id) ?? []).map(toVenueField)
      // Inside a venue, the field that earns the most reads first.
      .sort((a, b) => b.revenue - a.revenue || b.liveMatches - a.liveMatches || a.fieldId - b.fieldId);
    return {
      venueId: v.id,
      name: v.venueName,
      city: v.city,
      isActive: v.isActive,
      rate: v.costPerMatch,
      altRate: v.perMatchRate,
      rateDisagrees: rateDisagrees(v),
      // A venue with no field has nothing attributed to it, so it cannot be billing that at zero.
      ratelessWarning: rows.length > 0 && rateMissing(v),
      fields: rows,
      /* THE VENUE TOTALS ARE THE SUM OF ITS FIELDS, computed here and nowhere else. Nothing on
       * this page reads a venue-level count from the server — venueRollupBreaks asserts it. */
      fieldCount: rows.length,
      liveMatches: sum(rows, (r) => r.liveMatches),
      cancelledMatches: sum(rows, (r) => r.cancelledMatches),
      spots: sum(rows, (r) => r.spots),
      revenue: sum(rows, (r) => r.revenue),
    };
  }).sort((a, b) => b.revenue - a.revenue || b.liveMatches - a.liveMatches || a.name.localeCompare(b.name));

  const lf = loose.map(toVenueField).sort((a, b) => b.revenue - a.revenue || b.liveMatches - a.liveMatches);
  return {
    unattributed: {
      fields: lf,
      fieldCount: lf.length,
      liveMatches: sum(lf, (r) => r.liveMatches),
      cancelledMatches: sum(lf, (r) => r.cancelledMatches),
      spots: sum(lf, (r) => r.spots),
      revenue: sum(lf, (r) => r.revenue),
      upcoming: lf.filter((r) => r.upcomingMatches > 0)
        .map((r) => ({ fieldId: r.fieldId, title: r.title, upcomingMatches: r.upcomingMatches }))
        .sort((a, b) => b.upcomingMatches - a.upcomingMatches),
    },
    venues: blocks,
    rateless: blocks.filter((b) => b.ratelessWarning),
    disagreements: blocks.filter((b) => b.rateDisagrees),
  };
}

/* ── THE ASSERTION THE PAGE IS BUILT ON ────────────────────────────────────────────────────────
 *
 * A venue's five totals must equal the sum of its fields'. That is the number most likely to
 * drift now that the page does the arithmetic: a filter applied to the field rows but not to the
 * total, a sort that drops a row, a rounding step in one place and not the other.
 *
 * It returns the BREAKS, not a boolean, so a failure names the venue and the column. An empty
 * array is the passing value — which is exactly the shape that also comes back from an empty
 * input, so every caller of this must pair it with a count. venue-rollup-test does.
 */
export type RollupBreak = { venueId: number; name: string; column: string; venueTotal: number; fieldSum: number };

export function venueRollupBreaks(blocks: VenueBlock[]): RollupBreak[] {
  const out: RollupBreak[] = [];
  for (const b of blocks) {
    const cols: [string, number, number][] = [
      ["fieldCount", b.fieldCount, b.fields.length],
      ["liveMatches", b.liveMatches, sum(b.fields, (f) => f.liveMatches)],
      ["cancelledMatches", b.cancelledMatches, sum(b.fields, (f) => f.cancelledMatches)],
      ["spots", b.spots, sum(b.fields, (f) => f.spots)],
      // Revenue is dollars with cents; compare at the cent, not at the float.
      ["revenue", Math.round(b.revenue * 100), Math.round(sum(b.fields, (f) => f.revenue) * 100)],
    ];
    for (const [column, venueTotal, fieldSum] of cols) {
      if (venueTotal !== fieldSum) out.push({ venueId: b.venueId, name: b.name, column, venueTotal, fieldSum });
    }
  }
  return out;
}
