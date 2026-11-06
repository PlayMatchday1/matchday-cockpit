// MATCH OPS, "WHO GETS IT": the audience builder's pure half, shared by Push Notifications and Offers (Figma 20828:192
// the filter rows, 20835:159 the Add filter menu, 20835:211 Last played, 20835:230 Exact players). Client-safe: the
// components, the routes and the guards all use it.
//
// THE FILTER LIST IS THE DESIGN'S (20835:159), grouped Where / When / How much / Who. The Push Notifications backend
// was not on staging when this was written (2026-11-06: every /admin/pushes* path answered with an HTML page, while
// /admin/offers/page answered), so the body one row becomes (filterBody) is the Clubhouse's proposal and stands as
// UNKNOWN in docs/matchday-api-facts.md until a payload proves it. Offers' backend takes only some of these filters
// (OFFERS_FILTERS, docs/offers/M3-ENDPOINTS.md), and its form is mapped both ways here so one builder serves both.
//
// DATES ARE WALL-CLOCK DAYS ("2026-10-01"), never instants; they are read with UTC getters and never re-shifted.

import type { AudienceMode, LastPlayed, Membership } from "./offersModel";

export type FilterGroup = "Where" | "When" | "How much" | "Who";
export type FilterKey =
  | "city" | "playedAt" | "neverPlayedAt" | "homeField"
  | "lastPlayed" | "firstPlayed" | "signedUp" | "upcomingBooking"
  | "matchesPlayed" | "matchesLast30" | "neverPlayed" | "freeFirstMatch"
  | "membership" | "usualDay" | "appVersion";
export type FilterOp =
  | "isAnyOf" | "isNotAnyOf" | "anyOf" | "is"
  | "before" | "since" | "between" | "moreThanDaysAgo" | "withinDays" | "never"
  | "atLeast" | "atMost" | "yes" | "no" | "used" | "notUsed" | "atLeastVersion";
// What a row's value box holds for an op.
export type ValueKind = "cities" | "fields" | "date" | "dateRange" | "days" | "int" | "intRange" | "choice" | "text" | "none";
export type OpDef = { op: FilterOp; label: string; kind: ValueKind };
export type FilterDef = { key: FilterKey; label: string; group: FilterGroup; hint: string; ops: OpDef[]; choices?: { value: string; label: string }[] };

const DATE_OPS: OpDef[] = [{ op: "before", label: "before", kind: "date" }, { op: "since", label: "since", kind: "date" }, { op: "between", label: "between", kind: "dateRange" }];
export const CATALOG: FilterDef[] = [
  { key: "city", label: "City", group: "Where", hint: "is / is not any of", ops: [{ op: "isAnyOf", label: "is any of", kind: "cities" }, { op: "isNotAnyOf", label: "is not any of", kind: "cities" }] },
  { key: "playedAt", label: "Played at", group: "Where", hint: "any of these fields", ops: [{ op: "anyOf", label: "any of", kind: "fields" }] },
  { key: "neverPlayedAt", label: "Never played at", group: "Where", hint: "any of these fields", ops: [{ op: "anyOf", label: "any of", kind: "fields" }] },
  { key: "homeField", label: "Home field", group: "Where", hint: "most played field is", ops: [{ op: "is", label: "is any of", kind: "fields" }] },
  { key: "lastPlayed", label: "Last played", group: "When", hint: "before / since / between / never", ops: [...DATE_OPS, { op: "moreThanDaysAgo", label: "more than", kind: "days" }, { op: "withinDays", label: "within", kind: "days" }, { op: "never", label: "never", kind: "none" }] },
  { key: "firstPlayed", label: "First played", group: "When", hint: "before / since / between", ops: DATE_OPS },
  { key: "signedUp", label: "Signed up", group: "When", hint: "before / since / between", ops: DATE_OPS },
  { key: "upcomingBooking", label: "Has an upcoming booking", group: "When", hint: "yes / no", ops: [{ op: "yes", label: "yes", kind: "none" }, { op: "no", label: "no", kind: "none" }] },
  { key: "matchesPlayed", label: "Matches played", group: "How much", hint: "at least / at most / between", ops: [{ op: "atLeast", label: "at least", kind: "int" }, { op: "atMost", label: "at most", kind: "int" }, { op: "between", label: "between", kind: "intRange" }] },
  { key: "matchesLast30", label: "Matches in last 30 days", group: "How much", hint: "at least / at most", ops: [{ op: "atLeast", label: "at least", kind: "int" }, { op: "atMost", label: "at most", kind: "int" }] },
  { key: "neverPlayed", label: "Never played", group: "How much", hint: "signed up, no matches yet", ops: [{ op: "yes", label: "signed up, no matches yet", kind: "none" }] },
  { key: "freeFirstMatch", label: "Free first match", group: "How much", hint: "used / not used", ops: [{ op: "used", label: "used", kind: "none" }, { op: "notUsed", label: "not used", kind: "none" }] },
  { key: "membership", label: "Membership", group: "Who", hint: "member / not / former", ops: [{ op: "is", label: "is", kind: "choice" }], choices: [{ value: "MEMBER", label: "Member" }, { value: "NON_MEMBER", label: "Not a member" }, { value: "FORMER", label: "Former member" }] },
  { key: "usualDay", label: "Day they usually play", group: "Who", hint: "weekday / weekend / day of week", ops: [{ op: "is", label: "is", kind: "choice" }], choices: [{ value: "WEEKDAY", label: "Weekday" }, { value: "WEEKEND", label: "Weekend" }, { value: "MON", label: "Monday" }, { value: "TUE", label: "Tuesday" }, { value: "WED", label: "Wednesday" }, { value: "THU", label: "Thursday" }, { value: "FRI", label: "Friday" }, { value: "SAT", label: "Saturday" }, { value: "SUN", label: "Sunday" }] },
  { key: "appVersion", label: "App version", group: "Who", hint: "1.88 or newer", ops: [{ op: "atLeastVersion", label: "is at least", kind: "text" }] },
];
export const GROUPS: FilterGroup[] = ["Where", "When", "How much", "Who"];
export const filterDef = (key: FilterKey): FilterDef => CATALOG.find((d) => d.key === key)!;
export const opDef = (key: FilterKey, op: FilterOp): OpDef => filterDef(key).ops.find((o) => o.op === op) ?? filterDef(key).ops[0];

// One row. Every value slot is always present (null when the op has no use for it) so the form never carries
// undefined; filterBody drops what the op doesn't use.
export type FilterRow = { id: string; key: FilterKey; op: FilterOp; ids: number[]; date: string | null; date2: string | null; n: number | null; n2: number | null; choice: string | null; text: string | null };
export type AudienceSpec = { mode: AudienceMode; filters: FilterRow[]; playersText: string };
export const emptySpec = (): AudienceSpec => ({ mode: "FILTERS", filters: [], playersText: "" });

// Which ops a host allows, by key. null is the whole catalog (Push Notifications). Offers names its own below.
export type Allowed = Partial<Record<FilterKey, FilterOp[]>> | null;
export const opsFor = (key: FilterKey, allowed: Allowed): OpDef[] => (allowed === null ? filterDef(key).ops : filterDef(key).ops.filter((o) => allowed[key]?.includes(o.op)));
export const keysFor = (allowed: Allowed): FilterKey[] => (allowed === null ? CATALOG.map((d) => d.key) : CATALOG.filter((d) => (allowed[d.key]?.length ?? 0) > 0).map((d) => d.key));

let seq = 0;
export const rowId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;
// A fresh row for a key: its first allowed op, with a usable value where one is needed (today for a date, 1 for a
// count, 30 days, the first choice, 1.88 for the app version).
export function newRow(key: FilterKey, allowed: Allowed, today: string, id: string = rowId()): FilterRow {
  const op = opsFor(key, allowed)[0] ?? filterDef(key).ops[0];
  return withOp({ id, key, op: op.op, ids: [], date: null, date2: null, n: null, n2: null, choice: null, text: null }, op.op, today);
}
// Changing the op keeps what still applies (a date stays a date, a count stays a count) and fills what is new.
export function withOp(r: FilterRow, op: FilterOp, today: string): FilterRow {
  const d = opDef(r.key, op);
  const def = filterDef(r.key);
  const out: FilterRow = { ...r, op };
  if (d.kind === "date") { out.date = r.date ?? today; out.date2 = null; }
  else if (d.kind === "dateRange") { out.date = r.date ?? today; out.date2 = r.date2 ?? out.date; }
  else { out.date = null; out.date2 = null; }
  if (d.kind === "days") { out.n = r.n ?? 30; out.n2 = null; }
  else if (d.kind === "int") { out.n = r.n ?? 1; out.n2 = null; }
  else if (d.kind === "intRange") { out.n = r.n ?? 1; out.n2 = r.n2 ?? Math.max(out.n, 3); }
  else { out.n = null; out.n2 = null; }
  out.choice = d.kind === "choice" ? r.choice ?? def.choices?.[0]?.value ?? null : null;
  out.text = d.kind === "text" ? r.text ?? "1.88" : null;
  if (d.kind !== "cities" && d.kind !== "fields") out.ids = [];
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// What is still missing from a row, in plain words, or null when it can be sent.
export function rowProblem(r: FilterRow): string | null {
  const k = opDef(r.key, r.op).kind;
  const label = filterDef(r.key).label;
  switch (k) {
    case "cities": return r.ids.length ? null : `${label}: pick at least one city.`;
    case "fields": return r.ids.length ? null : `${label}: pick at least one field.`;
    case "date": return r.date && DAY.test(r.date) ? null : `${label}: pick a date.`;
    case "dateRange": return !r.date || !r.date2 || !DAY.test(r.date) || !DAY.test(r.date2) ? `${label}: pick both dates.` : r.date2 < r.date ? `${label}: the second date is before the first.` : null;
    case "days": return r.n !== null && Number.isInteger(r.n) && r.n >= 1 ? null : `${label}: how many days?`;
    case "int": return r.n !== null && Number.isInteger(r.n) && r.n >= 0 ? null : `${label}: how many matches?`;
    case "intRange": return r.n === null || r.n2 === null || !Number.isInteger(r.n) || !Number.isInteger(r.n2) || r.n < 0 ? `${label}: give both numbers.` : r.n2 < r.n ? `${label}: the second number is below the first.` : null;
    case "choice": return r.choice ? null : `${label}: pick one.`;
    case "text": return r.text && /^\d+(\.\d+)*$/.test(r.text.trim()) ? null : `${label}: a version like 1.88.`;
    case "none": return null;
  }
}
export const specProblem = (s: AudienceSpec): string | null => (s.mode !== "FILTERS" ? null : s.filters.map(rowProblem).find((p) => p !== null) ?? null);

// "Oct 1, 2026" from a wall-clock day, with UTC getters so the day never shifts.
export function dayLabel(day: string): string {
  if (!DAY.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}
export const todayWall = (nowWall: string) => nowWall.slice(0, 10);

type Named = { id: number; name?: string; title?: string };
const names = (ids: number[], xs: Named[], what: string) => ids.map((id) => { const x = xs.find((y) => y.id === id); return x?.name ?? x?.title ?? `${what} ${id}`; });
export const choiceLabel = (key: FilterKey, value: string | null) => filterDef(key).choices?.find((c) => c.value === value)?.label ?? value ?? "";

// One row in words: "City is any of Austin, San Antonio", "Last played before Oct 1, 2026".
export function rowText(r: FilterRow, cities: Named[], fields: Named[]): string {
  const def = filterDef(r.key);
  const o = opDef(r.key, r.op);
  const v = (): string => {
    switch (o.kind) {
      case "cities": return names(r.ids, cities, "City").join(", ") || "…";
      case "fields": return names(r.ids, fields, "Field").join(", ") || "…";
      case "date": return r.date ? dayLabel(r.date) : "…";
      case "dateRange": return `${r.date ? dayLabel(r.date) : "…"} and ${r.date2 ? dayLabel(r.date2) : "…"}`;
      case "days": return `${r.n ?? "…"} days`;
      case "int": return `${r.n ?? "…"}`;
      case "intRange": return `${r.n ?? "…"} and ${r.n2 ?? "…"}`;
      case "choice": return choiceLabel(r.key, r.choice);
      case "text": return r.text ?? "…";
      case "none": return "";
    }
  };
  if (r.key === "neverPlayed") return "Never played";
  if (r.key === "upcomingBooking") return `${r.op === "yes" ? "Has" : "No"} upcoming booking`;
  if (r.key === "freeFirstMatch") return `Free first match ${r.op === "used" ? "used" : "not used"}`;
  if (r.key === "lastPlayed" && r.op === "never") return "Never played";
  if (r.key === "lastPlayed" && r.op === "moreThanDaysAgo") return `Last played ${r.n ?? "…"}+ days ago`;
  if (r.key === "lastPlayed" && r.op === "withinDays") return `Played in the last ${r.n ?? "…"} days`;
  if (r.key === "appVersion") return `App ${r.text ?? "…"} or newer`;
  const val = v();
  return `${def.label} ${o.label}${val ? ` ${val}` : ""}`;
}
// The list's audience line: every row, " · " between, or "Everyone" with no rows.
export function specText(s: AudienceSpec, cities: Named[], fields: Named[], playersCount: number): string {
  if (s.mode === "PLAYERS") return `${playersCount.toLocaleString("en-US")} chosen ${playersCount === 1 ? "player" : "players"}`;
  return s.filters.length ? s.filters.map((r) => rowText(r, cities, fields)).join(" · ") : "Everyone";
}

// Under the Last played options (20835:211).
export function lastPlayedNote(r: FilterRow): string {
  const tail = ' "Never" means signed up but no match yet.';
  switch (r.op) {
    case "before": return `Players whose most recent match was before ${r.date ? dayLabel(r.date) : "that day"}.${tail}`;
    case "since": return `Players whose most recent match was on or after ${r.date ? dayLabel(r.date) : "that day"}.${tail}`;
    case "between": return `Players whose most recent match was between ${r.date ? dayLabel(r.date) : "…"} and ${r.date2 ? dayLabel(r.date2) : "…"}.${tail}`;
    case "moreThanDaysAgo": return `Players whose most recent match was more than ${r.n ?? "N"} days ago.${tail}`;
    case "withinDays": return `Players who played in the last ${r.n ?? "N"} days.${tail}`;
    case "never": return "Players who signed up but have no match yet.";
    default: return "";
  }
}

// THE ADD FILTER MENU (20835:159): the catalog, grouped, minus the keys already on the form (one row per key: a
// second "City" row could only contradict the first), narrowed by the search box over label and hint.
export type MenuEntry = { key: FilterKey; label: string; hint: string };
// hints: what a narrower host's rows can say, in place of the catalog's (Offers: OFFERS_HINTS).
export function menuGroups(search: string, allowed: Allowed, used: FilterKey[], hints: Partial<Record<FilterKey, string>> = {}): { group: FilterGroup; entries: MenuEntry[] }[] {
  const q = search.trim().toLowerCase();
  const keys = keysFor(allowed).filter((k) => !used.includes(k));
  return GROUPS.map((group) => ({
    group,
    entries: CATALOG.filter((d) => d.group === group && keys.includes(d.key)).map((d) => ({ key: d.key, label: d.label, hint: hints[d.key] ?? d.hint }))
      .filter((e) => !q || `${e.label} ${e.hint}`.toLowerCase().includes(q)),
  })).filter((g) => g.entries.length > 0);
}

// THE BODY (proposed, UNKNOWN until the backend proves it): one object per row, with only the slots the op uses.
export type FilterBody = { key: FilterKey; op: FilterOp; ids?: number[]; date?: string; date2?: string; n?: number; n2?: number; choice?: string; text?: string };
export function filterBody(r: FilterRow): FilterBody {
  const k = opDef(r.key, r.op).kind;
  const b: FilterBody = { key: r.key, op: r.op };
  if (k === "cities" || k === "fields") b.ids = [...r.ids].sort((x, y) => x - y);
  if (k === "date" || k === "dateRange") b.date = r.date ?? undefined;
  if (k === "dateRange") b.date2 = r.date2 ?? undefined;
  if (k === "days" || k === "int" || k === "intRange") b.n = r.n ?? undefined;
  if (k === "intRange") b.n2 = r.n2 ?? undefined;
  if (k === "choice") b.choice = r.choice ?? undefined;
  if (k === "text") b.text = r.text?.trim() ?? undefined;
  return b;
}
export const rowsOf = (filters: FilterBody[] | undefined | null): FilterRow[] =>
  (filters ?? []).map((b, i) => ({ id: `s${i}`, key: b.key, op: b.op, ids: b.ids ?? [], date: b.date ?? null, date2: b.date2 ?? null, n: b.n ?? null, n2: b.n2 ?? null, choice: b.choice ?? null, text: b.text ?? null }));
export type AudienceBody = { audienceMode: "FILTERS"; filters: FilterBody[] } | { audienceMode: "PLAYERS"; playerIds: number[] };
export const audienceBodyOf = (s: AudienceSpec, playerIds: number[]): AudienceBody =>
  s.mode === "PLAYERS" ? { audienceMode: "PLAYERS", playerIds: [...new Set(playerIds)].sort((x, y) => x - y) } : { audienceMode: "FILTERS", filters: s.filters.map(filterBody) };

// ── EXACT PLAYERS (20835:230) ──────────────────────────────────────────────────────────────────
// What was pasted, one token per id, email or phone, in the order typed, duplicates dropped.
export type Tokens = { ids: number[]; emails: string[]; phones: string[]; bad: string[]; all: string[] };
export function parseTokens(text: string): Tokens {
  const out: Tokens = { ids: [], emails: [], phones: [], bad: [], all: [] };
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (/^#?\d{1,9}$/.test(t)) { out.ids.push(Number(t.replace("#", ""))); out.all.push(t.replace("#", "")); }
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { out.emails.push(key); out.all.push(key); }
    else if (/^\+?[\d\s().-]{7,}$/.test(t) && t.replace(/\D/g, "").length >= 7) { out.phones.push(t); out.all.push(t); }
    else out.bad.push(t);
  }
  return out;
}
export type FoundPlayer = { id: number; name: string | null; city?: string | null; allowsPush?: boolean | null; token?: string };
export type TokenLookup = { players: FoundPlayer[]; notFound: string[] };
// "#78 Ryan M." on a tag.
export function tagText(p: FoundPlayer): string {
  const parts = (p.name ?? "").trim().split(/\s+/).filter(Boolean);
  const short = parts.length === 0 ? "" : parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
  return `#${p.id}${short ? ` ${short}` : ""}`;
}
// Takes one pasted token out of the box (a tag's ×), keeping the rest one line per line as typed.
export function removeToken(text: string, token: string): string {
  const k = token.trim().toLowerCase().replace(/^#/, "");
  return text.split("\n").map((line) => line.split(/[,;]+/).map((t) => t.trim()).filter((t) => t && t.toLowerCase().replace(/^#/, "") !== k).join(", ")).filter(Boolean).join("\n");
}
export const notFoundText = (nf: string[]) => `${nf.length} not found: ${nf.slice(0, 4).join(", ")}${nf.length > 4 ? "…" : ""}`;
// "5 players · 4 allow pushes" (the second part only when the lookup says who allows pushes).
export function playersLine(players: FoundPlayer[]): string {
  const n = players.length;
  const allow = players.filter((p) => p.allowsPush === true).length;
  const known = players.some((p) => typeof p.allowsPush === "boolean");
  return `${n.toLocaleString("en-US")} ${n === 1 ? "player" : "players"}${known ? ` · ${allow.toLocaleString("en-US")} allow pushes` : ""}`;
}

// ── THE COUNT BAR (20835:156) ─────────────────────────────────────────────────────────────────
// "412 players match · 338 allow pushes · 10% held back to measure". allowPush is absent where the host can't
// say (Offers' count has no push column), and then that part is left out.
export type AudienceCount = { count: number; allowPush?: number | null; holdoutPercent: number; heldBack: number };
export function countLine(c: AudienceCount): string {
  const parts = [`${c.count.toLocaleString("en-US")} ${c.count === 1 ? "player matches" : "players match"}`];
  if (typeof c.allowPush === "number") parts.push(`${c.allowPush.toLocaleString("en-US")} allow pushes`);
  if (c.holdoutPercent > 0) parts.push(`${c.holdoutPercent}% held back to measure`);
  return parts.join(" · ");
}

// ── OFFERS ──────────────────────────────────────────────────────────────────────────────────────
// What the Offers backend takes (M3-ENDPOINTS "Audience"): cities (any of), played at, last played as more than N
// days ago or never, matches played, membership member / not. Anything else is not offered on that page.
export const OFFERS_FILTERS: Allowed = {
  city: ["isAnyOf"], playedAt: ["anyOf"], lastPlayed: ["moreThanDaysAgo", "never"], matchesPlayed: ["atLeast", "atMost", "between"], membership: ["is"],
};
export const OFFERS_HINTS: Partial<Record<FilterKey, string>> = { city: "is any of", lastPlayed: "more than N days ago / never", membership: "member / not" };
export const OFFERS_MEMBERSHIP = [{ value: "MEMBER", label: "Member" }, { value: "NON_MEMBER", label: "Not a member" }];
export type OfferAudience = { audienceMode: AudienceMode; cityIds: number[]; fieldIds: number[]; lastPlayed: LastPlayed; lastPlayedDays: number | null; minMatches: number; maxMatches: number | null; membership: Membership; playerIdsText: string };
export function specOfOffer(a: OfferAudience): AudienceSpec {
  const rows: FilterRow[] = [];
  const row = (key: FilterKey, op: FilterOp, v: Partial<FilterRow>): FilterRow => ({ id: `o-${key}`, key, op, ids: [], date: null, date2: null, n: null, n2: null, choice: null, text: null, ...v });
  if (a.cityIds.length) rows.push(row("city", "isAnyOf", { ids: a.cityIds }));
  if (a.lastPlayed === "LAPSED") rows.push(row("lastPlayed", "moreThanDaysAgo", { n: a.lastPlayedDays ?? 30 }));
  if (a.lastPlayed === "NEVER") rows.push(row("lastPlayed", "never", {}));
  if (a.fieldIds.length) rows.push(row("playedAt", "anyOf", { ids: a.fieldIds }));
  if (a.minMatches > 0 && a.maxMatches !== null) rows.push(row("matchesPlayed", "between", { n: a.minMatches, n2: a.maxMatches }));
  else if (a.minMatches > 0) rows.push(row("matchesPlayed", "atLeast", { n: a.minMatches }));
  else if (a.maxMatches !== null) rows.push(row("matchesPlayed", "atMost", { n: a.maxMatches }));
  if (a.membership !== "ANYONE") rows.push(row("membership", "is", { choice: a.membership === "MEMBERS" ? "MEMBER" : "NON_MEMBER" }));
  return { mode: a.audienceMode, filters: rows, playersText: a.playerIdsText };
}
// Back to the Offers form's own fields. A row the Offers backend can't take (none can be added on that page, but a
// row could be edited into one) falls back to the nearest it can: a between with no top is at least, and so on.
export function offerOfSpec(s: AudienceSpec): Omit<OfferAudience, "playerIdsText"> & { playerIdsText: string } {
  const out = { audienceMode: s.mode, cityIds: [] as number[], fieldIds: [] as number[], lastPlayed: "ANY" as LastPlayed, lastPlayedDays: null as number | null, minMatches: 0, maxMatches: null as number | null, membership: "ANYONE" as Membership, playerIdsText: s.playersText };
  for (const r of s.filters) {
    if (r.key === "city") out.cityIds = [...r.ids];
    else if (r.key === "playedAt") out.fieldIds = [...r.ids];
    else if (r.key === "lastPlayed") { if (r.op === "never") out.lastPlayed = "NEVER"; else { out.lastPlayed = "LAPSED"; out.lastPlayedDays = r.n ?? 30; } }
    else if (r.key === "matchesPlayed") {
      if (r.op === "atLeast") { out.minMatches = r.n ?? 0; out.maxMatches = null; }
      else if (r.op === "atMost") { out.minMatches = 0; out.maxMatches = r.n; }
      else { out.minMatches = r.n ?? 0; out.maxMatches = r.n2; }
    } else if (r.key === "membership") out.membership = r.choice === "MEMBER" ? "MEMBERS" : r.choice === "NON_MEMBER" ? "NON_MEMBERS" : "ANYONE";
  }
  return out;
}
