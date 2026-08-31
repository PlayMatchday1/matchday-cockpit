/* MEMBERS BY CITY — the model. Nothing here fetches and nothing here writes.
 *
 * ── THE CORRECTED MODEL, WHICH IS THE WHOLE POINT OF THIS FILE ────────────────────────────────
 * A cancellation does NOT flip `status` to CANCELED until it rolls off. Measured on production
 * 2026-08-31: of 406 active people, 149 already carry a `canceled_at`. So BOTH cancellation
 * cohorts are SUBSETS of the active set, never additions to it:
 *
 *     Being charged = Active − (cancelled inside the window)
 *
 * It is a subtraction. A build that adds the cohorts to Active, or that treats a cancellation as
 * having already left the active base, double-counts 149 people and overstates billing by $8,218.
 * The suite asserts the subset relation on every row for exactly this reason.
 *
 * ── DOLLARS AND CENTS ─────────────────────────────────────────────────────────────────────────
 * `price` on mdapi_subscriptions is DOLLARS. `MemberLike.price_cents` is CENTS. Everything here
 * goes through memberLikeFromSubscription and works in CENTS; `price` is never read directly. A
 * caller that forgets the ×100 does not get a type error, it gets a plausible number.
 *
 * ── WHY THE DATES COMPARE AS TEXT ─────────────────────────────────────────────────────────────
 * `canceled_at` is TRUE UTC — proven on 1,556 dated rows: the column suffix is +00:00, raw.canceledAt
 * carries Z, the two never disagree on the instant, and the UTC hour histogram troughs across the
 * real Central night. The cutoff and window are calendar dates in that same UTC frame, so YYYY-MM-DD
 * against YYYY-MM-DD is the correct comparison and a Date would only add a re-shift.
 * THIS IS THE OPPOSITE MODEL FROM mdapi_matches.start_date, which carries a Z it does not mean.
 * Never share a date helper between this file and anything match-shaped.
 */

import { cityFromAbbr } from "./cityMap";
import { isActiveAsOf, memberLikeFromSubscription } from "./membershipStats";

/* ── THE TWO CONSTANTS, IN ONE PLACE ──────────────────────────────────────────────────────────
 * The window is THE CALENDAR MONTH ENDING AT THE CUTOFF, and both ends are INCLUSIVE — a
 * cancellation stamped on either boundary date is in-window. Next month is a one-line change to
 * each of these two strings; there is deliberately no date picker, because the page answers one
 * question about one cycle and a picker invites a reader to build a historical figure this data
 * cannot support (see the isActiveAsOf note below). */
export const CUTOFF_YMD = "2026-08-06";
export const WINDOW_START_YMD = "2026-07-06";

/* THE THREE TIERS THE MIX NAMES, in CENTS, highest first. Eleven distinct non-$0 prices exist;
 * these three cover 390 of 410. Everything else — $500, $50, $35, $29, $25, $15, $13, $1 — rolls
 * into ONE "other" entry that carries its own headcount and its own exact dollar sum, so the mix
 * still totals to the cent. Never average, never headcount × nominal. */
export const MIX_TIERS_CENTS = [6600, 4900, 3000] as const;

/* THE UNASSIGNED ROW EXISTS BECAUSE memberLikeFromSubscription RETURNS NULL FOR AN UNMAPPED CITY.
 * That null is a SKIP, and a skip is precisely how a new market vanishes from a dashboard without
 * anyone noticing. isActiveAsOf never reads `.city` — price_cents, email, status and
 * activation_date are its only terms — so re-mapping an unmapped row through a placeholder code
 * changes nothing about whether it counts, and the person is then grouped under their REAL code
 * in the Unassigned row where they can be seen. Zero rows take this path today (all seven live
 * codes map); it is here so the eighth does not disappear the day it launches. */
const CITY_PROBE = "ATX";
export const UNASSIGNED_CODE = "—";

export type SubscriptionRow = {
  user_id?: number | string | null;
  status?: string | null;
  price?: number | null;
  member_email?: string | null;
  activation_date?: string | null;
  canceled_at?: string | null;
  city_identifier?: string | null;
};

export type MixEntry = {
  /** Cents for a named tier; "other" for the rolled-up remainder. */
  tier: number | "other";
  heads: number;
  cents: number;
};

export type ByCityRow = {
  /** city_identifier, verbatim — the grouping key. UNASSIGNED_CODE when the row carries none. */
  code: string;
  /** Friendly name from cityFromAbbr, or null when the code is not in the map. */
  city: string | null;
  active: number;
  /** SUBSET of active. */
  cancelledInWindow: number;
  /** SUBSET of active. */
  cancelledAfterCutoff: number;
  /** active − cancelledInWindow. */
  beingCharged: number;
  /** Sum over the mix. Equals Σ heads × price, exactly, with `other` included. */
  billingCents: number;
  /** Always four entries, in MIX_TIERS_CENTS order then "other". Heads sum to beingCharged. */
  mix: MixEntry[];
};

export type MembersByCityTable = {
  rows: ByCityRow[];
  total: ByCityRow;
  /** People considered — active, non-$0, collapsed one per user_id. */
  people: number;
  /** How many rows the page pulled, and whether the pull was complete. */
  rowsPulled: number;
};

const ymd = (s: string | null | undefined): string => String(s ?? "").slice(0, 10);

/** In-window means cancelled on or after the window start AND on or before the cutoff — both ends
 *  inclusive, the one definition this estate holds (isChurning was changed to match on 2026-08-31). */
export const isInWindow = (canceledAt: string | null | undefined): boolean => {
  const d = ymd(canceledAt);
  return d !== "" && d >= WINDOW_START_YMD && d <= CUTOFF_YMD;
};

/** After the cutoff — the cohort that still owes one more cycle. */
export const isAfterCutoff = (canceledAt: string | null | undefined): boolean => {
  const d = ymd(canceledAt);
  return d !== "" && d > CUTOFF_YMD;
};

type Person = { userId: string; code: string; priceCents: number; canceledAt: string | null };

/* THE COLLAPSE: one row per user_id. 419 people hold more than one non-$0 row and 142 hold a live
 * membership beside a dead one, so counting rows double-counts them. Measured today NOBODY holds
 * two ACTIVE rows, so the highest-price tie-break never fires — it is here because "never fires
 * today" is not a guarantee, and a silent second row would land in billing as a second charge. */
function collapseToPeople(rows: readonly SubscriptionRow[], asOf: Date): Person[] {
  const byUser = new Map<string, Person>();
  for (const r of rows) {
    const code = String(r.city_identifier ?? "").trim();
    const m =
      memberLikeFromSubscription(r) ??
      memberLikeFromSubscription({ ...r, city_identifier: CITY_PROBE });
    if (!m) continue;
    if (!isActiveAsOf(m, asOf)) continue;
    const userId = String(r.user_id ?? `membership:${r.activation_date}:${m.price_cents}`);
    const prev = byUser.get(userId);
    if (prev && prev.priceCents >= m.price_cents) continue;
    byUser.set(userId, {
      userId,
      code: code === "" ? UNASSIGNED_CODE : code,
      priceCents: m.price_cents,
      canceledAt: m.canceled_at,
    });
  }
  return [...byUser.values()];
}

/* THE MIX IS BUILT FROM THE BEING-CHARGED SET, not from the active set, so heads sum to Being
 * charged and the dollars are what is actually about to be billed. Exact by construction: every
 * person lands in exactly one entry and contributes their own price, so no rounding step exists
 * to drift and no tail can be dropped. */
function buildMix(people: readonly Person[]): { mix: MixEntry[]; billingCents: number } {
  const mix: MixEntry[] = MIX_TIERS_CENTS.map((tier) => ({ tier, heads: 0, cents: 0 }));
  const other: MixEntry = { tier: "other", heads: 0, cents: 0 };
  for (const p of people) {
    const slot = mix.find((e) => e.tier === p.priceCents) ?? other;
    slot.heads += 1;
    slot.cents += p.priceCents;
  }
  const all = [...mix, other];
  return { mix: all, billingCents: all.reduce((s, e) => s + e.cents, 0) };
}

function makeRow(code: string, people: readonly Person[]): ByCityRow {
  const cancelledInWindow = people.filter((p) => isInWindow(p.canceledAt)).length;
  const charged = people.filter((p) => !isInWindow(p.canceledAt));
  const { mix, billingCents } = buildMix(charged);
  return {
    code,
    city: code === UNASSIGNED_CODE ? null : cityFromAbbr(code),
    active: people.length,
    cancelledInWindow,
    cancelledAfterCutoff: people.filter((p) => isAfterCutoff(p.canceledAt)).length,
    beingCharged: charged.length,
    billingCents,
    mix,
  };
}

export function buildMembersByCity(
  rows: readonly SubscriptionRow[],
  asOf: Date,
): MembersByCityTable {
  const people = collapseToPeople(rows, asOf);

  const byCode = new Map<string, Person[]>();
  for (const p of people) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p]);
  // The Unassigned row is ALWAYS present, even at zero — an empty row says "checked, none",
  // where an absent one says nothing at all and is indistinguishable from a market being dropped.
  if (!byCode.has(UNASSIGNED_CODE)) byCode.set(UNASSIGNED_CODE, []);

  const out = [...byCode.entries()]
    .map(([code, ps]) => makeRow(code, ps))
    // Unassigned sinks to the bottom; the rest by size, so the biggest market reads first.
    .sort((a, b) =>
      (a.code === UNASSIGNED_CODE ? 1 : 0) - (b.code === UNASSIGNED_CODE ? 1 : 0) ||
      b.active - a.active ||
      a.code.localeCompare(b.code),
    );

  return {
    rows: out,
    total: { ...makeRow("TOTAL", people), city: null },
    people: people.length,
    rowsPulled: rows.length,
  };
}

/* ── FORMATTERS, shared by the table and the CSV so the two cannot disagree ─────────────────── */

export const dollars = (cents: number): string =>
  "$" + Math.round(cents / 100).toLocaleString("en-US");

export const tierLabel = (t: number | "other"): string =>
  t === "other" ? "other" : `$${t / 100}`;

/** "78 × $66 · 7 × $49 · 19 × $30 · 6 × other ($68)" — empty tiers are dropped, never shown as 0. */
export const mixLabel = (mix: readonly MixEntry[]): string =>
  mix
    .filter((e) => e.heads > 0)
    .map((e) =>
      e.tier === "other"
        ? `${e.heads} × other (${dollars(e.cents)})`
        : `${e.heads} × ${tierLabel(e.tier)}`,
    )
    .join(" · ");

/* ── CSV — the same numbers as the screen, with the mix EXPANDED one column per tier so the file
 * opens as arithmetic rather than as a string somebody has to re-parse. ─────────────────────── */
export function membersByCityCsv(t: MembersByCityTable, asOfLabel: string): string {
  const head = [
    "City", "Code", "Active",
    `Cancelled ${WINDOW_START_YMD} to ${CUTOFF_YMD}`,
    `Cancelled after ${CUTOFF_YMD}`,
    "Being charged",
    ...MIX_TIERS_CENTS.map((c) => `Heads ${tierLabel(c)}`),
    "Heads other", "Other dollars", "Billing next cycle",
  ];
  const cell = (s: string | number) => {
    const v = String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const line = (r: ByCityRow, label: string) => [
    label, r.code, r.active, r.cancelledInWindow, r.cancelledAfterCutoff, r.beingCharged,
    ...MIX_TIERS_CENTS.map((c) => r.mix.find((e) => e.tier === c)?.heads ?? 0),
    r.mix.find((e) => e.tier === "other")?.heads ?? 0,
    ((r.mix.find((e) => e.tier === "other")?.cents ?? 0) / 100).toFixed(2),
    (r.billingCents / 100).toFixed(2),
  ].map(cell).join(",");

  return [
    `# Members by City — as of ${asOfLabel}. Excludes price $0.`,
    head.map(cell).join(","),
    ...t.rows.map((r) => line(r, r.city ?? "Unassigned")),
    line(t.total, "TOTAL"),
  ].join("\n");
}
