// CHURN — the pure model. No React, no fetch, no clock of its own (today is always passed in).
//
// ── WHAT WAS WRONG, AND WHAT EACH RULE HERE IS FOR ───────────────────────────────────────────
//
// 9,427 "potential churn players" is a third of everyone who ever registered, and most of them
// played once in 2023 and drifted. A list that long is not a list, it is the database. Measured on
// production at the 90-day floor: all time 9,427 · last 12 months 4,719 · THIS YEAR 3,166, split
// Heavy 577 · Regular 760 · Tried it 1,829. So the window is the single biggest lever and it now
// defaults to this year.
//
// 10 was an unexplained constant compiled into the page. It is a CONTROL now, and the middle tier's
// label is DERIVED from it — "3 to 9 matches" when the threshold is 10 — so the two can never
// disagree. That relationship is what the suite asserts; the number 10 is not special and is not
// pinned anywhere.
//
// The old list showed a bare Player ID. A churn list you cannot contact is a report, not a task.

import { isRelayEmail } from "./matchManagers";

/* ── THE WINDOW ────────────────────────────────────────────────────────────────────────────────
 * TWO BOUNDS, AND THEY ARE NOT THE SAME THING:
 *   · the FLOOR ("not played for N days") is how stale a player must be to count at all;
 *   · the WINDOW START is how far back the page is willing to look.
 * Player 9, last seen September 2024 and 704 days gone, satisfied the floor and sat beside someone
 * who lapsed in May. The floor cannot exclude them — only the window can. */
export type WindowKind = "ytd" | "12m" | "all";
export const WINDOWS: { kind: WindowKind; label: string }[] = [
  { kind: "ytd", label: "This year" },
  { kind: "12m", label: "12 months" },
  { kind: "all", label: "All time" },
];
export const DEFAULT_WINDOW: WindowKind = "ytd";

/** The earliest last-played date the page will show. `today` is YYYY-MM-DD, always injected. */
export function windowStart(kind: WindowKind, today: string): string {
  if (kind === "ytd") return `${today.slice(0, 4)}-01-01`;
  if (kind === "12m") {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  return "0000-01-01"; // all time — earlier than any last_match_date
}

/** The date box overrides the buttons; picking a button clears the box. One control wins at a time. */
export function effectiveStart(kind: WindowKind, override: string | null, today: string): string {
  return override && override.trim() ? override.trim() : windowStart(kind, today);
}

/* ── THE TIERS ─────────────────────────────────────────────────────────────────────────────────
 * Three, split on matches played, and the labels are the FACT rather than advice. "Worth a phone
 * call" is a judgement the page is not entitled to make about 577 people at once. */
export type Tier = "heavy" | "regular" | "tried";
export const TIERS: Tier[] = ["heavy", "regular", "tried"];
export const REGULAR_FLOOR = 3;
export const DEFAULT_HEAVY = 10;
export const HEAVY_MIN = REGULAR_FLOOR + 1; // the middle tier must keep at least one value
export const HEAVY_MAX = 50;

export const clampHeavy = (n: number): number =>
  Math.max(HEAVY_MIN, Math.min(HEAVY_MAX, Math.round(Number.isFinite(n) ? n : DEFAULT_HEAVY)));

export function tierOf(matches: number, heavy: number): Tier {
  const h = clampHeavy(heavy);
  if (matches >= h) return "heavy";
  return matches >= REGULAR_FLOOR ? "regular" : "tried";
}

export const TIER_NAME: Record<Tier, string> = { heavy: "Heavy", regular: "Regular", tried: "Tried it" };

/* EVERY TILE STATES ITS OWN DEFINITION, and the middle one is DERIVED from the threshold rather
 * than written down. When the stepper says 14, the middle tile reads "3 to 13 matches" — a page
 * where the tile and the filter disagree is the bug this derivation exists to make impossible. */
export function tierDefinition(t: Tier, heavy: number): string {
  const h = clampHeavy(heavy);
  if (t === "heavy") return `${h}+ matches`;
  if (t === "regular") return h - 1 === REGULAR_FLOOR ? `${REGULAR_FLOOR} matches` : `${REGULAR_FLOOR} to ${h - 1} matches`;
  return "one or two matches, then gone";
}

/** The inclusive bounds a tier actually filters on — the same numbers the label is built from. */
export function tierBounds(t: Tier, heavy: number): { min: number; max: number } {
  const h = clampHeavy(heavy);
  if (t === "heavy") return { min: h, max: Infinity };
  if (t === "regular") return { min: REGULAR_FLOOR, max: h - 1 };
  return { min: 1, max: REGULAR_FLOOR - 1 };
}

/* ── THE ROW ───────────────────────────────────────────────────────────────────────────────────
 * Everything needed to CONTACT someone, because that is the only thing this page is for. */
export type ChurnRow = {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string;
  field: string;
  matches: number;
  spent: number;      // dollars, before they stopped
  last: string;       // YYYY-MM-DD
  days: number;
  isMember: boolean;
};

export const daysGone = (last: string, today: string): number =>
  Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000));

/** Past this many days the figure is red. Roughly three quarters gone. */
export const DAYS_RED = 270;
export const isStale = (days: number): boolean => days > DAYS_RED;

/* AN APPLE RELAY ADDRESS IS LABELLED, NEVER PRINTED — a random token reads as corrupt data and is
 * not something anyone can write to. For those people the PHONE is the route, which is why the
 * phone column never drops, on any screen width. Same rule and same helper as Match Managers. */
export function emailDisplay(r: Pick<ChurnRow, "email">): { text: string; kind: "address" | "relay" | "none" } {
  const e = String(r.email ?? "").trim();
  if (!e) return { text: "No email on file", kind: "none" };
  if (isRelayEmail(e)) return { text: "Apple private relay", kind: "relay" };
  return { text: e, kind: "address" };
}

/** Can this person be reached, and if not, the reason — never a silent blank. */
/* ── A DELETED ACCOUNT IS NOT A CONTACT ────────────────────────────────────────────────────────
 * A scrubbed account keeps a row in growth_player_profile — the matches happened — but its email
 * has been rewritten to `del_<hash>@playmatchday.com` and there is nobody at the other end.
 * Measured: 161 of 1,000 churn candidates, 16% of a list whose entire purpose is contacting people.
 * They are excluded, and the count SAYS SO rather than quietly getting smaller. */
export const isScrubbed = (email: string | null | undefined): boolean =>
  /^del_[0-9a-f]+@playmatchday\.com$/i.test(String(email ?? "").trim());

export function contactRoute(r: Pick<ChurnRow, "email" | "phone">): { reachable: boolean; how: string } {
  const e = emailDisplay(r);
  if (r.phone && e.kind === "address") return { reachable: true, how: "phone or email" };
  if (r.phone) return { reachable: true, how: e.kind === "relay" ? "phone — the address is an Apple relay" : "phone — no email on file" };
  if (e.kind === "address") return { reachable: true, how: "email — no phone on file" };
  return { reachable: false, how: e.kind === "relay" ? "no phone, and the address is an Apple relay" : "no phone and no email on file" };
}

/* ── `ev` IS A LIST OF EVENTS, NOT A NUMBER ────────────────────────────────────────────────────
 * growth_player_profile.ev holds "YYYY-MM|CITY|Field|amount" strings. The last segment is what they
 * paid, so the spend is a parse and a sum, and a row whose ev is missing is 0 rather than absent. */
export function spentFromEv(ev: unknown): number {
  if (!Array.isArray(ev)) return 0;
  let total = 0;
  for (const e of ev) {
    const parts = String(e ?? "").split("|");
    const n = Number(parts[parts.length - 1]);
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 100) / 100;
}

/* ── FILTERING ─────────────────────────────────────────────────────────────────────────────────
 * The floor is a FLOOR: no row below it, ever. Clicking a tier filters; clicking the same tier
 * again clears it — a filter you cannot undo from the control that set it is a trap. */
export type ChurnFilter = { start: string; floorDays: number; tier: Tier | null; heavy: number };

export function applyFilter(rows: readonly ChurnRow[], f: ChurnFilter): ChurnRow[] {
  const h = clampHeavy(f.heavy);
  return rows.filter((r) => {
    if (r.days < f.floorDays) return false;      // the floor, honoured absolutely
    if (r.last < f.start) return false;          // the window
    if (f.tier && tierOf(r.matches, h) !== f.tier) return false;
    return true;
  });
}

/** Clicking a tile: the same tier twice clears it. */
export const toggleTier = (current: Tier | null, clicked: Tier): Tier | null => (current === clicked ? null : clicked);

export function tierCounts(rows: readonly ChurnRow[], heavy: number): Record<Tier, number> {
  const out: Record<Tier, number> = { heavy: 0, regular: 0, tried: 0 };
  for (const r of rows) out[tierOf(r.matches, heavy)]++;
  return out;
}

/** What the footer says: how much this list spent before it stopped. */
export const totalSpent = (rows: readonly ChurnRow[]): number =>
  Math.round(rows.reduce((a, r) => a + r.spent, 0) * 100) / 100;

export const memberCount = (rows: readonly ChurnRow[]): number => rows.filter((r) => r.isMember).length;

/* ── NARROW SCREENS ────────────────────────────────────────────────────────────────────────────
 * Field, Spent and Last played go. NAME, EMAIL, PHONE and DAYS GONE stay, because reaching someone
 * is what the page is for and a phone number is the only route to the relay addresses. */
export const NARROW_DROP = ["field", "spent", "last"] as const;
export const NARROW_KEEP = ["name", "email", "phone", "days"] as const;
export const dropsOnNarrow = (col: string): boolean => (NARROW_DROP as readonly string[]).includes(col);
