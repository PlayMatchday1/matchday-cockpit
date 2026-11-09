// PLAYER DATA ROOM — the list builder's model (2026-11-09). Pure: no fetch, no React. The route
// (/api/lifecycle/dataroom) and the panel both read it, so the filters a saved list stores, the
// sentence that describes them and the CSV Klaviyo imports cannot drift apart.
//
// THE DATA is migration 0267: dataroom_played_list / dataroom_never_played / dataroom_pivot run in
// Postgres. "Played" = growth_participation, own PLAYER spot, not a match the person managed, a match
// day before today (Chicago) — the same rule as Churn's 0264.
//
// DATES. Match days are WALL-CLOCK days (start_date's "Z" is local time); "today" is America/Chicago.

import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";

// ── filters ─────────────────────────────────────────────────────────────────────────────────────
export type QuickPeriod = "this" | "last" | "last3" | "last4";
/** Months are YYYY-MM. null = any time. */
export type Period = { quick: QuickPeriod } | { from: string; to: string } | null;
export type PlayerType = "all" | "members" | "non_members";
/** min ≥ 1; max null = "or more". */
export type MatchRule = { min: number; max: number | null };
export const WITHIN_DAYS = [7, 14, 21, 30, 45] as const;

export type PlayedFilters = {
  city: string | null;        // city_identifier
  fieldIds: number[];         // LIVE field ids; hidden duplicates are folded in when the list runs
  period: Period;
  type: PlayerType;
  matches: MatchRule;
  within: number | null;      // last played within N days, at the same fields
};
export type NeverFilters = { from: string; to: string; city: string | null };

/** "Clear all": every player who has ever played. Empty and valid — no control is left half-set. */
export const emptyPlayed = (): PlayedFilters => ({ city: null, fieldIds: [], period: null, type: "all", matches: { min: 1, max: null }, within: null });

export const QUICK_LABEL: Record<QuickPeriod, string> = { this: "This month", last: "Last month", last3: "Last 3 months", last4: "Last 4 months" };

/** Parse a saved or posted filter object into a valid one. Anything malformed falls back to empty. */
export function cleanPlayed(x: unknown): PlayedFilters {
  const f = (x ?? {}) as Record<string, unknown>;
  const out = emptyPlayed();
  if (typeof f.city === "string" && /^[A-Z]{2,5}$/.test(f.city)) out.city = f.city;
  if (Array.isArray(f.fieldIds)) out.fieldIds = [...new Set(f.fieldIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  const p = f.period as Record<string, unknown> | null | undefined;
  if (p && typeof p.quick === "string" && p.quick in QUICK_LABEL) out.period = { quick: p.quick as QuickPeriod };
  else if (p && isMonth(p.from) && isMonth(p.to)) out.period = p.from <= p.to ? { from: p.from, to: p.to } : { from: p.to, to: p.from };
  if (f.type === "members" || f.type === "non_members") out.type = f.type;
  const m = f.matches as Record<string, unknown> | undefined;
  if (m) {
    const min = Math.max(1, Math.floor(Number(m.min) || 1));
    const max = m.max == null || m.max === "" ? null : Math.floor(Number(m.max));
    out.matches = { min, max: max != null && Number.isFinite(max) && max >= min ? max : null };
  }
  if (WITHIN_DAYS.includes(Number(f.within) as (typeof WITHIN_DAYS)[number])) out.within = Number(f.within);
  return out;
}
export function cleanNever(x: unknown, today: string): NeverFilters {
  const f = (x ?? {}) as Record<string, unknown>;
  const last = monthAdd(today.slice(0, 7), -1);
  let from = isMonth(f.from) ? f.from : last, to = isMonth(f.to) ? f.to : from;
  if (from > to) [from, to] = [to, from];
  return { from, to, city: typeof f.city === "string" && /^[A-Z]{2,5}$/.test(f.city) ? f.city : null };
}

// ── months and days ─────────────────────────────────────────────────────────────────────────────
const MN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function monthAdd(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
export const monthShort = (ym: string) => `${MN[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;
export const monthLong = (ym: string) => `${MN[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const chicagoToday = (now = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
export const chicagoDayOf = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The months a period covers, from today. "Last N months" ends with the current month. */
export function periodMonths(p: Period, today: string): { from: string; to: string } | null {
  if (!p) return null;
  const cur = today.slice(0, 7);
  if ("quick" in p) {
    if (p.quick === "this") return { from: cur, to: cur };
    if (p.quick === "last") return { from: monthAdd(cur, -1), to: monthAdd(cur, -1) };
    return { from: monthAdd(cur, p.quick === "last3" ? -2 : -3), to: cur };
  }
  return { from: p.from, to: p.to };
}
export function periodDays(p: Period, today: string): { from: string | null; to: string | null } {
  const m = periodMonths(p, today);
  return m ? { from: `${m.from}-01`, to: monthEnd(m.to) } : { from: null, to: null };
}
export function monthSpan(from: string, to: string): string {
  return from === to ? monthShort(from) : `${monthShort(from)} – ${monthShort(to)}`;
}
export function periodLabel(p: Period, today: string): string {
  const m = periodMonths(p, today);
  if (!p || !m) return "Any time";
  return "quick" in p ? `${QUICK_LABEL[p.quick]} · ${monthSpan(m.from, m.to)}` : monthSpan(m.from, m.to);
}

// ── the sentence ────────────────────────────────────────────────────────────────────────────────
export const cityName = (code: string | null | undefined): string => (code ? CITY_CODE_TO_DISPLAY[code] ?? code : "");

const joinNames = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** "between July and October" in one year; with years when it crosses one. */
function periodPhrase(p: Period, today: string): string {
  const m = periodMonths(p, today);
  if (!p || !m) return "";
  if ("quick" in p) return p.quick === "this" ? "this month" : p.quick === "last" ? "last month" : `in the ${QUICK_LABEL[p.quick].toLowerCase()}`;
  const name = (ym: string, withYear: boolean) => (withYear ? monthLong(ym) : MN[Number(ym.slice(5, 7)) - 1]);
  if (m.from === m.to) return `in ${name(m.from, m.from.slice(0, 4) !== today.slice(0, 4))}`;
  const sameYear = m.from.slice(0, 4) === m.to.slice(0, 4);
  const thisYear = sameYear && m.to.slice(0, 4) === today.slice(0, 4);
  return `between ${name(m.from, !thisYear)} and ${name(m.to, !thisYear)}`;
}

export function describePlayed(f: PlayedFilters, today: string, fieldTitle: (id: number) => string): string {
  const who = f.type === "members" ? "Members" : f.type === "non_members" ? "Non-members" : "Players";
  const { min, max } = f.matches;
  const count = max != null
    ? (min === max ? ` exactly ${min} ${min === 1 ? "match" : "matches"}` : ` between ${min} and ${max} matches`)
    : min > 1 ? ` ${min}+ matches` : "";
  const place = f.fieldIds.length ? ` at ${joinNames(f.fieldIds.map(fieldTitle))}` : f.city ? ` in ${cityName(f.city)}` : "";
  const when = periodPhrase(f.period, today);
  const recent = f.within ? `, and played${place ? " there" : ""} in the last ${f.within} days` : "";
  return `${who} who played${count}${place}${when ? ` ${when}` : ""}${recent}`;
}
export function describeNever(f: NeverFilters, today: string): string {
  const where = f.city ? ` in ${cityName(f.city)}` : "";
  const when = f.from === f.to ? `in ${monthLong(f.from)}` : `between ${monthLong(f.from)} and ${monthLong(f.to)}`;
  void today;
  return `Registered${where} ${when} and haven't played a match yet`;
}

// ── contacts ────────────────────────────────────────────────────────────────────────────────────
/** E.164, or null when the number cannot be made into one. US/Canada 10 or 11 digits; a number
 *  already written with "+" is kept if it has 8–15 digits. Nothing is guessed beyond that. */
export function e164(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
/** "+1 214 ••• ••••" — the preview shows the area code, never the number. */
export function maskPhone(p: string | null): string {
  if (!p) return "";
  if (p.startsWith("+1") && p.length === 12) return `+1 ${p.slice(2, 5)} ••• ••••`;
  return `${p.slice(0, 3)} ••• •••`;
}
const validEmail = (e: string | null | undefined): e is string => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export type PlayedRow = {
  id: number; first: string | null; last: string | null; email: string | null; phone: string | null;
  home: string | null; member: boolean; matches: number; lastPlayed: string; city: string | null;
};
export type NeverRow = { id: number; first: string | null; last: string | null; email: string | null; phone: string | null; home: string | null; signedUp: string };

/** A row as the preview and the CSV see it: E.164 phone, display city, and its two flags. */
export function contactOf(r: { first: string | null; last: string | null; email: string | null; phone: string | null }) {
  const email = validEmail(r.email) ? r.email.trim() : null;
  const phone = e164(r.phone);
  return { name: [r.first, r.last].filter(Boolean).join(" ") || "No name", email, phone, noEmail: !email, noPhone: !phone };
}

export type SortKey = "name" | "email" | "phone" | "city" | "matches" | "lastPlayed" | "signedUp";
export function sortRows<T extends PlayedRow | NeverRow>(rows: T[], key: SortKey, dir: "asc" | "desc"): T[] {
  const val = (r: T): string | number => {
    const c = contactOf(r);
    switch (key) {
      case "name": return c.name.toLowerCase();
      case "email": return (c.email ?? "~").toLowerCase();
      case "phone": return c.phone ?? "~";
      case "city": return cityName("city" in r ? r.city ?? r.home : r.home).toLowerCase() || "~";
      case "matches": return "matches" in r ? r.matches : 0;
      case "lastPlayed": return "lastPlayed" in r ? r.lastPlayed : "";
      case "signedUp": return "signedUp" in r ? r.signedUp : "";
    }
  };
  const k = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * k || a.id - b.id; });
}

// ── the Klaviyo CSV ─────────────────────────────────────────────────────────────────────────────
/* Klaviyo's import maps these headers on sight: Email, Phone Number (E.164), First Name, Last Name,
 * City. The rest arrive as custom properties. A cell that starts with = + - @ is a formula to a
 * spreadsheet; names and cities get a leading apostrophe, the phone column (always "+…") does not. */
const cell = (v: string | number | boolean | null | undefined, guard = true): string => {
  let s = v == null ? "" : String(v);
  if (guard && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function playedCsv(rows: PlayedRow[]): string {
  const head = "Email,Phone Number,First Name,Last Name,City,Matches In Period,Last Played,Member,Player ID";
  const lines = rows.map((r) => {
    const c = contactOf(r);
    return [cell(c.email), cell(c.phone, false), cell(r.first), cell(r.last), cell(cityName(r.city ?? r.home)),
      r.matches, r.lastPlayed, r.member ? "Yes" : "No", r.id].join(",");
  });
  return [head, ...lines].join("\r\n") + "\r\n";
}
export function neverCsv(rows: NeverRow[], today: string): string {
  const head = "Email,Phone Number,First Name,Last Name,City,Signed Up,Days Since Signup,Player ID";
  const lines = rows.map((r) => {
    const c = contactOf(r), day = chicagoDayOf(r.signedUp);
    return [cell(c.email), cell(c.phone, false), cell(r.first), cell(r.last), cell(cityName(r.home)), day, daysBetween(day, today), r.id].join(",");
  });
  return [head, ...lines].join("\r\n") + "\r\n";
}

// ── live fields and their retired duplicates ────────────────────────────────────────────────────
/* A soft-deleted field (MatchDay hides it: GET /admin/fields filters deleted_at) still carries its
 * history. Lowell's "Discount" duplicate 1948 held 11 matches through 2026-10-28, all of them Lowell.
 * So a hidden field is FOLDED into a live field of the same fin_venue: picking Lowell (1387) reads
 * 1387 and 1948. Fields excluded_from_venue never fold. When a venue has several live fields, the
 * hidden one goes to the live field whose title shares the longest prefix with it (lowest id on a tie). */
export type LiveField = { id: number; title: string; city: string | null };
export type VenueLink = { venue: number; field: number; title: string; excluded: boolean };
export function foldHidden(live: LiveField[], links: VenueLink[]): Record<number, number> {
  const isLive = new Set(live.map((f) => f.id));
  const title = new Map(live.map((f) => [f.id, f.title.toLowerCase()]));
  const byVenue = new Map<number, VenueLink[]>();
  for (const l of links) if (!l.excluded) (byVenue.get(l.venue) ?? byVenue.set(l.venue, []).get(l.venue)!).push(l);
  const prefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const out: Record<number, number> = {};
  for (const ls of byVenue.values()) {
    const lv = [...new Set(ls.filter((l) => isLive.has(l.field)).map((l) => l.field))].sort((a, b) => a - b);
    if (!lv.length) continue;
    for (const h of ls) {
      if (isLive.has(h.field)) continue;
      const t = h.title.toLowerCase();
      out[h.field] = lv.reduce((best, id) => (prefix(t, title.get(id) ?? "") > prefix(t, title.get(best) ?? "") ? id : best), lv[0]);
    }
  }
  return out;
}
/** The field ids a list reads: the chosen live fields plus everything folded into them. */
export function expandFields(ids: number[], fold: Record<number, number>): number[] {
  const want = new Set(ids);
  const out = new Set(ids);
  for (const [h, l] of Object.entries(fold)) if (want.has(l)) out.add(Number(h));
  return [...out].sort((a, b) => a - b);
}

// ── the pivot ───────────────────────────────────────────────────────────────────────────────────
export const PIVOT_DIMS = ["City", "Field", "Month", "Year", "Cohort year", "Cohort month"] as const;
export type PivotDim = (typeof PIVOT_DIMS)[number];
export type PivotShow = "players" | "new" | "spots" | "revenue";
export const SHOW_LABEL: Record<PivotShow, string> = { players: "Players", new: "New players", spots: "Spots", revenue: "Revenue (Finance net, pre-tax)" };
/** Finance's net is recorded by month and venue, so revenue splits by these and nothing else. */
export const REVENUE_DIMS: readonly PivotDim[] = ["City", "Field", "Month", "Year"];

export type PivotSpec = {
  rows: PivotDim[];            // 0–2
  col: PivotDim | null;
  show: PivotShow | null;
  from: string; to: string;    // months
  city: string | null;         // city_identifier
  fieldId: number | null;      // a live field id
};
export const pivotReady = (s: PivotSpec): boolean => !!s.show && (s.rows.length > 0 || s.col != null);
export function revenueBlocked(s: Pick<PivotSpec, "rows" | "col" | "show">): string | null {
  if (s.show !== "revenue") return null;
  const bad = [...s.rows, ...(s.col ? [s.col] : [])].filter((d) => !REVENUE_DIMS.includes(d));
  return bad.length ? `Revenue is Finance's net, recorded by month and venue, not by player, so it can't be split by ${bad.join(" or ").toLowerCase()}.` : null;
}

/** One cell of the table: the SQL's GROUPING SETS row, or a revenue sum. */
export type PivotCell = { r1: string; r2: string; c: string; g: number; v: number };
export type PivotTableData = {
  rowKeys: string[];               // "r1\u0001r2"
  colKeys: string[];               // [""] when there is no column
  cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grand: number;
  additive: boolean;               // spots / revenue sum; players are distinct counts
};
export const SEP = "\u0001";
/** Order: months and years in time order, everything else by label. */
function orderKeys(keys: string[], dim: PivotDim | null | undefined, label: (d: PivotDim | null | undefined, k: string) => string): string[] {
  const timeLike = dim === "Month" || dim === "Year" || dim === "Cohort month" || dim === "Cohort year";
  return [...keys].sort((a, b) => (timeLike ? a.localeCompare(b) : label(dim, a).localeCompare(label(dim, b))));
}
export function assemblePivot(cells: PivotCell[], spec: PivotSpec, additive: boolean, label: (d: PivotDim | null | undefined, k: string) => string): PivotTableData {
  const rk = (c: PivotCell) => `${c.r1}${SEP}${c.r2}`;
  const table: PivotTableData = { rowKeys: [], colKeys: [], cells: {}, rowTotals: {}, colTotals: {}, grand: 0, additive };
  const rows = new Set<string>(), cols = new Set<string>();
  for (const c of cells) {
    if (c.g === 0) { rows.add(rk(c)); cols.add(c.c); (table.cells[rk(c)] ??= {})[c.c] = c.v; }
    else if (c.g === 1) table.rowTotals[rk(c)] = c.v;
    else if (c.g === 6) table.colTotals[c.c] = c.v;
    else if (c.g === 7) table.grand = c.v;
  }
  /* Rows sort on the first dimension, then the second, each in its own order. */
  const r1 = orderKeys([...new Set([...rows].map((k) => k.split(SEP)[0]))], spec.rows[0], label);
  table.rowKeys = r1.flatMap((a) => orderKeys([...rows].filter((k) => k.split(SEP)[0] === a).map((k) => k.split(SEP)[1]), spec.rows[1], label).map((b) => `${a}${SEP}${b}`));
  table.colKeys = spec.col ? orderKeys([...cols], spec.col, label) : [""];
  return table;
}
/** Revenue cells from fin_txn_sums rows (already reduced to dims), with every total a plain sum. */
export function sumCells(items: { r1: string; r2: string; c: string; v: number }[]): PivotCell[] {
  const add = (m: Map<string, PivotCell>, c: PivotCell) => { const k = `${c.g}|${c.r1}|${c.r2}|${c.c}`; const e = m.get(k); if (e) e.v += c.v; else m.set(k, { ...c }); };
  const m = new Map<string, PivotCell>();
  for (const it of items) {
    add(m, { ...it, g: 0 });
    add(m, { r1: it.r1, r2: it.r2, c: "", g: 1, v: it.v });
    add(m, { r1: "", r2: "", c: it.c, g: 6, v: it.v });
    add(m, { r1: "", r2: "", c: "", g: 7, v: it.v });
  }
  return [...m.values()].map((c) => ({ ...c, v: Math.round(c.v * 100) / 100 }));
}

/** The Played filters behind a pivot number. null = it cannot be expressed (a cohort dimension, or
 *  New players, which counts a player only in their first month). */
export function drillToPlayed(spec: PivotSpec, rowKey: string, colKey: string, venueFields?: (venueKey: string) => number[]): PlayedFilters | null {
  if (spec.show === "new") return null;
  const f = emptyPlayed();
  let from = spec.from, to = spec.to;
  const parts: [PivotDim | null | undefined, string][] = [[spec.rows[0], rowKey.split(SEP)[0]], [spec.rows[1], rowKey.split(SEP)[1]], [spec.col, colKey]];
  f.city = spec.city;
  if (spec.fieldId != null) f.fieldIds = [spec.fieldId];
  for (const [d, v] of parts) {
    if (!d || v === "" || v == null) continue;
    if (d === "Cohort month" || d === "Cohort year") return null;
    if (d === "City") f.city = v;
    if (d === "Field") {
      const ids = spec.show === "revenue" ? venueFields?.(v) ?? [] : [Number(v)];
      if (!ids.length || ids.some((n) => !Number.isFinite(n))) return null;
      f.fieldIds = ids;
    }
    if (d === "Month") { if (v > from) from = v; if (v < to) to = v; }
    if (d === "Year") { if (`${v}-01` > from) from = `${v}-01`; if (`${v}-12` < to) to = `${v}-12`; }
  }
  if (from > to) return null;
  f.period = { from, to };
  return f;
}
