// FIELD-ID ADMIN — the pure model behind /admin/fields.
//
// WHAT THIS PAGE IS. `fin_venue_fields` maps one MatchDay `field_id` to one
// `fin_venues` row, and Finance keys every cost and every attribution off that
// link. The table is MANUAL: a new field appears on a match and joins to
// nothing, so its matches and its money reach Finance as UNATTRIBUTED. Until
// now the only way to see that was to write SQL (migration 0142 is the
// artefact of doing it by hand). This is the surface over the table that
// already exists — not a new mechanism.
//
// WHAT IT DELIBERATELY DOES NOT DO. No auto-grouping, no name matching, no
// auto-create. `venueResolver`'s RULES table exists and would happily guess
// that "Tourney ATH Katy" is ATH Katy — and it would be right this time. It is
// not consulted here. The page SURFACES the evidence (title, city, address,
// zip, counts, dates, money) and a human decides. The one place a name is
// pre-filled is the new-venue name box, which is a text default a person edits
// and confirms, not a mapping.
//
// NOTHING HERE IMPORTS SUPABASE OR REACT. The route fetches rows; this file
// turns them into facts; the component renders them. The consequence preview
// in particular is pure so it can be asserted offline — it is the number Ryan
// commits an assignment against.

import { venueCategory } from "./venueResolver";
import { CITIES, type City } from "./types";

// ── the row: ONE PER FIELD ID, never per venue ──────────────────────────────

/** What a field ID is mapped to today, or null for UNMAPPED. */
export type FieldMapping = {
  venueId: number;
  venueName: string;
  venueCity: string | null;
  venueIsActive: boolean;
  /** fin_venue_fields.counts_as_regular_play — the per-link event exception (migration 0130). */
  countsAsRegularPlay: boolean;
  /** field_title_at_link — the title captured when the link was made, for drift detection. */
  titleAtLink: string | null;
};

export type FieldIdRow = {
  fieldId: number;
  /** The title on the field's MOST RECENT match — what MatchDay sends today. */
  title: string | null;
  /** >1 means the title has been renamed upstream at least once. */
  titleVariants: number;
  /** city_name as MatchDay sends it — NOT normalized. Warsaw and New York City
   *  are real values here and are not in the cockpit's CITIES list. */
  city: string | null;
  address: string | null;
  zip: string | null;

  liveMatches: number;       // is_cancelled = false
  cancelledMatches: number;  // is_cancelled = true
  upcomingMatches: number;   // live, start in the future
  firstMatch: string | null; // yyyy-mm-dd, live only
  lastMatch: string | null;  // yyyy-mm-dd, live only

  /** DAILY PAID revenue in DOLLARS. See dppRevenue note in buildFieldIdIndex. */
  dppRevenue: number;
  dppSpots: number;

  // ── cost-preview inputs, derived per match row ──
  // "billable" = not classified as an event by its OWN title, which is the test
  // financeCosts.isEventSchedule applies. Carried as counts so the preview
  // never re-reads match rows.
  billableLive: number;
  billableCancelled: number;
  /** DISTINCT (date, time) among billable live matches — the bills_per_reservation unit. */
  billableSlotsLive: number;
  /** DISTINCT (date, time) among billable live AND cancelled — chargedUnitCount adds both to ONE set. */
  billableSlotsWithCancelled: number;
  /** Live matches falling on a Sunday — the ATH Katy split leg (venueGroups.resolveSplitRateVenueId). */
  sundayLive: number;

  mapping: FieldMapping | null;
};

/** A fin_venues row as the assign dialog needs it, plus what it is made of today. */
export type VenueOption = {
  id: number;
  venueName: string;
  city: string | null;
  isActive: boolean;
  billingType: string | null;
  /** As Billed reads per_match_rate ONLY — cost_per_match is a different model (financeCosts:209). */
  perMatchRate: number | null;
  costPerMatch: number | null;
  chargeOnCancel: boolean;
  billsPerReservation: boolean;
  /** Field IDs linked to this venue today. */
  fieldCount: number;
  /** Live matches / revenue this venue already collects across its linked field IDs. */
  liveMatches: number;
  dppRevenue: number;
  /** Set when this venue routes through a split-rate rule (ATH Katy Sunday, Soccer Central). */
  split: { kind: "sunday" | "capacity"; partnerName: string; partnerRate: number | null } | null;
};

export type FieldsPayload = {
  fields: FieldIdRow[];
  venues: VenueOption[];
  /** When the heavy mdapi aggregate was computed (it is cached; the mapping is not). */
  aggregateAt: string;
  matchRows: number;
  playerRows: number;
};

// ── the aggregate ───────────────────────────────────────────────────────────

export type MatchAggInput = {
  api_id: number;
  field_id: number;
  field_title: string | null;
  field_address: string | null;
  field_zipcode: string | null;
  city_name: string | null;
  city_identifier: string | null;
  start_date: string | null;
  /** TRUE UTC, server-derived. The ONLY column that can answer "is this match in
   *  the future" — start_date is a wall clock and comparing it to an instant is
   *  wrong by the field's offset. */
  start_date_utc: string | null;
  is_cancelled: boolean | null;
};

export type PlayerAggInput = {
  match_api_id: number;
  amount: number | null;
  user_email: string | null;
  user_is_fake_player: boolean | null;
  is_absent: boolean | null;
};

/** Anchored, exactly as src/lib/mdapiFakePlayer.ts — @playmatchday.com staff are REAL. */
const FAKE_EMAIL = /@matchday\.com$/i;
function isFake(p: PlayerAggInput): boolean {
  return p.user_is_fake_player === true || FAKE_EMAIL.test((p.user_email ?? "").trim());
}

/**
 * WALL CLOCK, NOT AN INSTANT — AND NO `new Date()` ON IT.
 *
 * `start_date` carries a `Z`/`+00:00` suffix and is NOT UTC
 * (docs/matchday-api-facts.md); it is the hour on the pitch. STRING SURGERY
 * ONLY: the date and the hour are sliced out of the text, never round-tripped
 * through a Date, so nothing can re-shift them. The day-of-week is then derived
 * from the CALENDAR DATE alone — a date with no time and no zone — which is the
 * same construction venueGroups.resolveSplitRateVenueId uses to route Sunday
 * matches, so the two cannot disagree about which day a match is on.
 */
export function wallClockParts(startDate: string | null): { date: string; time: string; sunday: boolean } | null {
  if (!startDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(startDate.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return {
    date: `${y}-${mo}-${d}`,
    time: `${hh}:${mi}`,
    sunday: !Number.isNaN(dow.getTime()) && dow.getUTCDay() === 0,
  };
}

const topOf = (m: Map<string, number>): string | null => {
  let best: string | null = null;
  let n = -1;
  for (const [k, c] of m) if (c > n) { best = k; n = c; }
  return best;
};
const bump = (m: Map<string, number>, k: string | null | undefined): void => {
  if (k == null || k === "") return;
  m.set(k, (m.get(k) ?? 0) + 1);
};

/**
 * Build one row per field ID out of the raw match + registration rows.
 *
 * dppRevenue is DAILY PAID revenue, defined exactly as
 * financeStats.venuePartnerRevenueFor defines it — the estate's source of
 * truth for "revenue earned at a pitch", and the figure migration 0142 used to
 * justify creating a venue:
 *
 *   · the match is alive (deleted_at is null — filtered at the read) and NOT cancelled
 *   · paid_status = 'PAID' with NO promocode  (= DAILY PAID)
 *   · the player is not a synthetic fake and not marked absent
 *   · amount is CENTS on the wire; converted here, once
 *
 * A player-cancelled row that was never refunded is deliberately INCLUDED: the
 * money was earned (partnerRentalDashboard.ts:105). Membership revenue is NOT
 * here — it is allocated at city grain and has no field to belong to.
 */
export function buildFieldIdIndex(
  matches: MatchAggInput[],
  players: PlayerAggInput[],
  nowMs: number,
): Map<number, Omit<FieldIdRow, "mapping">> {
  type Acc = {
    titles: Map<string, number>; addrs: Map<string, number>;
    zips: Map<string, number>; cities: Map<string, number>;
    live: number; cancelled: number; upcoming: number;
    firstMs: number | null; lastMs: number | null;
    latestMs: number | null; latestTitle: string | null;
    billableLive: number; billableCancelled: number;
    slotsLive: Set<string>; slotsBoth: Set<string>;
    sundayLive: number;
    dpp: number; spots: number;
  };
  const acc = new Map<number, Acc>();
  const get = (id: number): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        titles: new Map(), addrs: new Map(), zips: new Map(), cities: new Map(),
        live: 0, cancelled: 0, upcoming: 0, firstMs: null, lastMs: null,
        latestMs: null, latestTitle: null,
        billableLive: 0, billableCancelled: 0,
        slotsLive: new Set(), slotsBoth: new Set(), sundayLive: 0,
        dpp: 0, spots: 0,
      };
      acc.set(id, a);
    }
    return a;
  };

  const matchById = new Map<number, MatchAggInput>();
  for (const m of matches) {
    if (m.field_id == null) continue;
    matchById.set(m.api_id, m);
    const a = get(m.field_id);
    bump(a.titles, m.field_title);
    bump(a.addrs, m.field_address);
    bump(a.zips, m.field_zipcode);
    bump(a.cities, m.city_name ?? m.city_identifier);

    const parts = wallClockParts(m.start_date);
    const ms = parts ? Date.parse(`${parts.date}T00:00:00Z`) : null;
    // The title shown is the one on the field's most recent match, cancelled or
    // not — "as MatchDay sends it" is about the name today, not about play.
    if (ms != null && (a.latestMs == null || ms > a.latestMs)) { a.latestMs = ms; a.latestTitle = m.field_title; }

    // The event test is the SAME regex the cost path applies, against the SAME
    // string (the match's own field_title). Reading it any other way here would
    // let the preview promise cost the cost path is going to drop.
    const billable = venueCategory(m.field_title) !== "event";
    const slot = parts ? `${parts.date}|${parts.time}` : `raw:${m.api_id}`;

    if (m.is_cancelled) {
      a.cancelled += 1;
      if (billable) { a.billableCancelled += 1; a.slotsBoth.add(slot); }
    } else {
      a.live += 1;
      if (ms != null) {
        if (a.firstMs == null || ms < a.firstMs) a.firstMs = ms;
        if (a.lastMs == null || ms > a.lastMs) a.lastMs = ms;
      }
      // start_date_utc, never start_date: the second is a wall clock and would
      // call a match upcoming (or past) by the field's UTC offset.
      const utc = m.start_date_utc ? Date.parse(m.start_date_utc) : NaN;
      if (!Number.isNaN(utc) && utc > nowMs) a.upcoming += 1;
      if (parts?.sunday) a.sundayLive += 1;
      if (billable) { a.billableLive += 1; a.slotsLive.add(slot); a.slotsBoth.add(slot); }
    }
  }

  for (const p of players) {
    const m = matchById.get(p.match_api_id);
    if (!m || m.field_id == null) continue;
    if (m.is_cancelled) continue;
    if (isFake(p)) continue;
    if (p.is_absent === true) continue;
    const a = get(m.field_id);
    a.dpp += (Number(p.amount) || 0) / 100; // cents on the wire — converted once
    a.spots += 1;
  }

  const out = new Map<number, Omit<FieldIdRow, "mapping">>();
  const day = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
  for (const [fieldId, a] of acc) {
    out.set(fieldId, {
      fieldId,
      title: a.latestTitle ?? topOf(a.titles),
      titleVariants: a.titles.size,
      city: topOf(a.cities),
      address: topOf(a.addrs),
      zip: topOf(a.zips),
      liveMatches: a.live,
      cancelledMatches: a.cancelled,
      upcomingMatches: a.upcoming,
      firstMatch: day(a.firstMs),
      lastMatch: day(a.lastMs),
      dppRevenue: Math.round(a.dpp * 100) / 100,
      dppSpots: a.spots,
      billableLive: a.billableLive,
      billableCancelled: a.billableCancelled,
      billableSlotsLive: a.slotsLive.size,
      billableSlotsWithCancelled: a.slotsBoth.size,
      sundayLive: a.sundayLive,
    });
  }
  return out;
}

// ── ordering and the default window ─────────────────────────────────────────

export const RECENT_MONTHS = 12;

/** A field ID is "recent" iff it has a LIVE match inside the last RECENT_MONTHS.
 *  A field with only cancelled matches, or none at all, has no lastMatch and is
 *  therefore not recent — which is the honest answer, not a hidden zero. */
export function isRecent(row: Pick<FieldIdRow, "lastMatch">, nowMs: number): boolean {
  if (!row.lastMatch) return false;
  const cut = new Date(nowMs);
  cut.setUTCMonth(cut.getUTCMonth() - RECENT_MONTHS);
  return Date.parse(`${row.lastMatch}T00:00:00Z`) >= Date.UTC(cut.getUTCFullYear(), cut.getUTCMonth(), cut.getUTCDate());
}

/** UNMAPPED FIRST, then by live match count desc, then field id asc.
 *  The order is the point of the page: what is unattributed and biggest is what costs money. */
export function sortFieldRows<T extends Pick<FieldIdRow, "fieldId" | "liveMatches" | "mapping">>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.mapping == null ? 0 : 1) - (b.mapping == null ? 0 : 1) ||
      b.liveMatches - a.liveMatches ||
      a.fieldId - b.fieldId,
  );
}

export function visibleFieldRows<T extends FieldIdRow>(rows: T[], showAll: boolean, nowMs: number): T[] {
  return sortFieldRows(showAll ? rows : rows.filter((r) => isRecent(r, nowMs)));
}

/** Other field IDs sharing this one's address or zip — EVIDENCE, not a suggestion.
 *  It is what proved the Lou Fusz and ATH Katy pairs. Nothing is selected from it. */
export function addressPeers(row: FieldIdRow, all: FieldIdRow[]): FieldIdRow[] {
  const addr = (row.address ?? "").trim().toLowerCase();
  const zip = (row.zip ?? "").trim();
  if (!addr && !zip) return [];
  return all.filter(
    (o) =>
      o.fieldId !== row.fieldId &&
      ((addr && (o.address ?? "").trim().toLowerCase() === addr) || (zip && (o.zip ?? "").trim() === zip)),
  );
}

// ── the consequence preview ─────────────────────────────────────────────────

export type CostConsequence = {
  kind: "per_match" | "reservation" | "profit_share" | "monthly_flat" | "no_rate" | "unknown";
  /** Billable units at the rate — matches, or reservations when the venue collapses slots. */
  units: number;
  unitNoun: string;
  rate: number | null;
  /** null means "not derivable at a rate" — never 0. A zero is a claim (0142). */
  amount: number | null;
  note: string;
};

export type AssignPreview = {
  venueName: string;
  /** live matches the venue gains */
  matchesGained: number;
  upcomingGained: number;
  cancelledGained: number;
  /** dollars that stop being unattributed */
  revenueAttributed: number;
  venueMatchesBefore: number;
  venueMatchesAfter: number;
  venueRevenueBefore: number;
  venueRevenueAfter: number;
  span: { first: string | null; last: string | null };
  cost: CostConsequence;
  /** Set when the field's own title makes its matches EVENTS, which carry no venue cost. */
  eventExclusion: { excludedLive: number; excludedCancelled: number; wouldHaveBeen: number | null } | null;
  splitNote: string | null;
  warnings: string[];
};

/**
 * WHAT THIS ASSIGNMENT WILL MOVE — computed before it is committed.
 *
 * The cost figure is As Billed: `per_match_rate × billable units`, the same
 * basis financeCosts.canonicalVenueCost uses, over the FIELD'S WHOLE HISTORY
 * (`span`), not a month. It is NOT the Field Costs number and must not be read
 * as one — that page is per-month and applies overrides. Stated on screen.
 *
 * Three exclusions are applied here because the cost path applies them:
 *   · events (the title's own EVENT_MARKERS) carry no venue cost
 *   · cancelled matches count only when the venue charges on cancel
 *   · a bills_per_reservation venue pays per (field, date, time) slot, not per row
 */
export function previewAssignment(row: FieldIdRow, venue: VenueOption): AssignPreview {
  const warnings: string[] = [];

  const chargeCancelled = venue.chargeOnCancel === true;
  const perReservation = venue.billsPerReservation === true;
  const units = perReservation
    ? (chargeCancelled ? row.billableSlotsWithCancelled : row.billableSlotsLive)
    : row.billableLive + (chargeCancelled ? row.billableCancelled : 0);
  const unitNoun = perReservation ? (units === 1 ? "reservation" : "reservations") : (units === 1 ? "match" : "matches");

  const rate = venue.perMatchRate;
  let cost: CostConsequence;
  if (venue.billingType === "profit_share") {
    cost = {
      kind: "profit_share", units, unitNoun, rate: null, amount: null,
      note:
        "Profit share — cost is the partner's payout, not a per-match rate. This assignment adds these matches to the payout base; " +
        "the amount owed is whatever the partner dashboard computes from the revenue they carry.",
    };
  } else if (venue.billingType === "monthly_flat") {
    cost = {
      kind: "monthly_flat", units, unitNoun, rate: null, amount: 0,
      note: "Monthly flat — the venue's cost does not move with match count. This assignment adds no cost.",
    };
  } else if (rate == null) {
    cost = {
      kind: "no_rate", units, unitNoun, rate: null, amount: null,
      note:
        "No per_match_rate on file. These matches will report as UNTRACKED, not as free. " +
        "A $0 rate claims the pitch costs nothing; NULL claims we do not know yet, and only one of those is true.",
    };
    if (venue.costPerMatch != null) {
      warnings.push(
        `This venue carries cost_per_match = $${venue.costPerMatch} but per_match_rate is NULL. ` +
          "As Billed reads per_match_rate only — the two columns are two different models, not one fact entered twice.",
      );
    }
  } else {
    cost = {
      kind: perReservation ? "reservation" : "per_match", units, unitNoun, rate,
      amount: Math.round(units * rate * 100) / 100,
      note: `${units} ${unitNoun} × $${rate} — As Billed (per_match_rate), over this field's whole history. Not the Field Costs figure, which is per month and applies overrides.`,
    };
  }

  // THE EVENT TRAP, NAMED. A field whose title carries an event marker
  // ("Tourney …") contributes ZERO venue cost however many matches it carries.
  // This is what let ATH Pearland's field 22 sit at $0 for 26 months and
  // $83,040 (migration 0130). The preview says it out loud rather than
  // rendering a $0 nobody can explain.
  const excludedLive = row.liveMatches - row.billableLive;
  const excludedCancelled = row.cancelledMatches - row.billableCancelled;
  const eventExclusion =
    excludedLive + excludedCancelled > 0
      ? {
          excludedLive,
          excludedCancelled,
          wouldHaveBeen:
            rate != null && venue.billingType !== "profit_share" && venue.billingType !== "monthly_flat"
              ? Math.round((excludedLive + (chargeCancelled ? excludedCancelled : 0)) * rate * 100) / 100
              : null,
        }
      : null;

  let splitNote: string | null = null;
  if (venue.split?.kind === "sunday") {
    splitNote =
      row.sundayLive > 0
        ? `${row.sundayLive} of these live matches fall on a Sunday and will route to "${venue.split.partnerName}"` +
          (venue.split.partnerRate != null ? ` at $${venue.split.partnerRate}/match, not $${rate ?? "—"}.` : ".")
        : `This venue splits Sunday matches to "${venue.split.partnerName}". None of this field's live matches fall on a Sunday, so nothing routes there.`;
  } else if (venue.split?.kind === "capacity") {
    splitNote =
      `This venue splits by capacity: matches over the tournament threshold route to "${venue.split.partnerName}", ` +
      "and a match with null/0 max_player_count drops out of cost entirely as a special event.";
  }

  if (row.city && venue.city && row.city !== venue.city && !cityLooseMatch(row.city, venue.city)) {
    warnings.push(`MatchDay reports this field in "${row.city}"; the venue is in "${venue.city}".`);
  }
  if (!venue.isActive) {
    warnings.push(`"${venue.venueName}" is marked INACTIVE in fin_venues.`);
  }

  return {
    venueName: venue.venueName,
    matchesGained: row.liveMatches,
    upcomingGained: row.upcomingMatches,
    cancelledGained: row.cancelledMatches,
    revenueAttributed: row.dppRevenue,
    venueMatchesBefore: venue.liveMatches,
    venueMatchesAfter: venue.liveMatches + row.liveMatches,
    venueRevenueBefore: venue.dppRevenue,
    venueRevenueAfter: Math.round((venue.dppRevenue + row.dppRevenue) * 100) / 100,
    span: { first: row.firstMatch, last: row.lastMatch },
    cost,
    eventExclusion,
    splitNote,
    warnings,
  };
}

/** MatchDay's city_name and fin_venues.city are two vocabularies
 *  ("Dallas / Fort Worth" vs "Dallas", "Oklahoma City" vs "OKC"). This decides
 *  only whether to RAISE A WARNING — it never picks a venue. */
export function cityLooseMatch(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const x = n(a), y = n(b);
  return x.includes(y) || y.includes(x);
}

// ── what the write path is allowed to be asked for ──────────────────────────

export type AssignRequest =
  | { mode: "existing"; fieldId: number; venueId: number; titleAtLink: string | null }
  | { mode: "new"; fieldId: number; venueName: string; city: string; billingType: string; titleAtLink: string | null };

export type AssignValidation = { ok: true; request: AssignRequest } | { ok: false; error: string };

export const NEW_VENUE_BILLING_TYPES = ["per_match", "profit_share", "monthly_flat"] as const;

export function isKnownCity(city: string): city is City {
  return (CITIES as readonly string[]).includes(city);
}

/**
 * Validate an assignment. Refuses, in order:
 *   1. a field ID that is already mapped (re-pointing a live link is a different,
 *      more consequential action and is NOT built — see the report)
 *   2. an unknown venue
 *   3. a new venue with no name, or a city outside the canonical CITIES list
 *   4. a new venue whose (name, city) already exists — that is "point at the
 *      existing one", and 0027 puts a UNIQUE on the pair anyway
 * NO RATE IS EVER SET on a venue created here. per_match_rate and cost_per_match
 * stay NULL so the pitch reports as UNTRACKED rather than as free (migration 0142).
 */
export function validateAssignment(
  input: {
    fieldId: number;
    mode: string;
    venueId?: number | null;
    venueName?: string | null;
    city?: string | null;
    billingType?: string | null;
  },
  ctx: { row: FieldIdRow | null; venues: VenueOption[] },
): AssignValidation {
  const row = ctx.row;
  if (!row) return { ok: false, error: `Field ${input.fieldId} has no match in mdapi_matches — nothing to map.` };
  if (row.mapping) {
    return {
      ok: false,
      error:
        `Field ${input.fieldId} is already mapped to "${row.mapping.venueName}" (#${row.mapping.venueId}). ` +
        "Re-pointing an existing link moves history off one venue and onto another and is not built here — change it in SQL, deliberately.",
    };
  }
  const titleAtLink = row.title ?? null;

  if (input.mode === "existing") {
    const venueId = Number(input.venueId);
    if (!Number.isInteger(venueId)) return { ok: false, error: "Pick a venue." };
    if (!ctx.venues.some((v) => v.id === venueId)) return { ok: false, error: `Venue #${venueId} does not exist.` };
    return { ok: true, request: { mode: "existing", fieldId: row.fieldId, venueId, titleAtLink } };
  }

  if (input.mode === "new") {
    const venueName = (input.venueName ?? "").trim();
    if (!venueName) return { ok: false, error: "The new venue needs a name." };
    const city = (input.city ?? "").trim();
    if (!city) return { ok: false, error: "Pick a city for the new venue." };
    if (!isKnownCity(city)) {
      return {
        ok: false,
        error:
          `"${city}" is not one of the cockpit's cities (${CITIES.join(", ")}). ` +
          "A venue in a city the app does not know drops out of every rollup and looks correct in the table.",
      };
    }
    const billingType = (input.billingType ?? "").trim();
    if (!(NEW_VENUE_BILLING_TYPES as readonly string[]).includes(billingType)) {
      return { ok: false, error: `Billing type must be one of: ${NEW_VENUE_BILLING_TYPES.join(", ")}.` };
    }
    const clash = ctx.venues.find(
      (v) => v.venueName.trim().toLowerCase() === venueName.toLowerCase() && (v.city ?? "") === city,
    );
    if (clash) {
      return {
        ok: false,
        error: `"${venueName}" already exists in ${city} (#${clash.id}). Point this field at that venue instead of creating a second row.`,
      };
    }
    return { ok: true, request: { mode: "new", fieldId: row.fieldId, venueName, city, billingType, titleAtLink } };
  }

  return { ok: false, error: `Unknown assignment mode ${JSON.stringify(input.mode)}.` };
}
