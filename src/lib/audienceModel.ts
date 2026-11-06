// MATCH OPS, "WHO GETS IT": the audience builder's pure half, shared by Push Notifications and Offers (Figma 20828:192
// the filter rows, 20835:159 the Add filter menu, 20835:211 Last played, 20835:230 Exact players). Client-safe: the
// components, the routes and the guards all use it.
//
// THE FILTER LIST IS THE DESIGN'S (20835:159), grouped Where / When / How much / Who, and what a row becomes on the
// wire is the backend's shared audience (backend docs/push-notifications.md, "The shared audience"; validated by
// core/audiences/audience.types.ts parseAudienceFilter): toContract / fromContract below. Offers on a backend from
// before the shared audience take only five filters in their old fields (OFFERS_FILTERS, specOfOffer / offerOfSpec).
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
  { key: "membership", label: "Membership", group: "Who", hint: "member / not / former", ops: [{ op: "is", label: "is", kind: "choice" }], choices: [{ value: "MEMBER", label: "Member" }, { value: "NOT_MEMBER", label: "Not a member" }, { value: "FORMER_MEMBER", label: "Former member" }] },
  { key: "usualDay", label: "Day they usually play", group: "Who", hint: "weekday / weekend / day of week", ops: [{ op: "is", label: "is", kind: "choice" }], choices: [{ value: "WEEKDAY", label: "Weekday" }, { value: "WEEKEND", label: "Weekend" }, { value: "MONDAY", label: "Monday" }, { value: "TUESDAY", label: "Tuesday" }, { value: "WEDNESDAY", label: "Wednesday" }, { value: "THURSDAY", label: "Thursday" }, { value: "FRIDAY", label: "Friday" }, { value: "SATURDAY", label: "Saturday" }, { value: "SUNDAY", label: "Sunday" }] },
  { key: "appVersion", label: "App version", group: "Who", hint: "1.88 or newer", ops: [{ op: "atLeastVersion", label: "is at least", kind: "text" }] },
];
export const GROUPS: FilterGroup[] = ["Where", "When", "How much", "Who"];
export const filterDef = (key: FilterKey): FilterDef => CATALOG.find((d) => d.key === key)!;
export const opDef = (key: FilterKey, op: FilterOp): OpDef => filterDef(key).ops.find((o) => o.op === op) ?? filterDef(key).ops[0];

// One row. Every value slot is always present (null when the op has no use for it) so the form never carries
// undefined; toContract sends only what the op uses.
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
// The backend's own limits (audience.types.ts): 20 filters, 200 ids in one list filter, 1 to 3650 days, counts to 100,000.
export const MAX_FILTERS = 20;
export const MAX_LIST_IDS = 200;
export const MAX_DAYS = 3650;
export function rowProblem(r: FilterRow): string | null {
  const k = opDef(r.key, r.op).kind;
  const label = filterDef(r.key).label;
  if ((k === "cities" || k === "fields") && r.ids.length > MAX_LIST_IDS) return `${label}: at most ${MAX_LIST_IDS} in one filter.`;
  if (k === "days" && r.n !== null && r.n > MAX_DAYS) return `${label}: at most ${MAX_DAYS.toLocaleString("en-US")} days.`;
  if ((k === "int" || k === "intRange") && ((r.n ?? 0) > 100000 || (r.n2 ?? 0) > 100000)) return `${label}: that number is too big.`;
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
export const specProblem = (s: AudienceSpec): string | null =>
  s.mode !== "FILTERS" ? null : s.filters.length > MAX_FILTERS ? `At most ${MAX_FILTERS} filters.` : s.filters.map(rowProblem).find((p) => p !== null) ?? null;

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

// ── THE WIRE FORMAT (backend docs/push-notifications.md, "The shared audience") ───────────────────────
export type ContractFilter = { type: string; op?: string; [k: string]: unknown };
export type ContractAudience = { mode: "FILTERS"; filters: ContractFilter[] } | { mode: "PLAYERS"; playerIds: number[] };
const TYPE: Record<FilterKey, string> = {
  city: "CITY", playedAt: "PLAYED_AT", neverPlayedAt: "NEVER_PLAYED_AT", homeField: "HOME_FIELD", lastPlayed: "LAST_PLAYED", firstPlayed: "FIRST_PLAYED",
  signedUp: "SIGNED_UP", upcomingBooking: "UPCOMING_BOOKING", matchesPlayed: "MATCHES_PLAYED", matchesLast30: "MATCHES_LAST_30_DAYS", neverPlayed: "NEVER_PLAYED",
  freeFirstMatch: "FREE_FIRST_MATCH", membership: "MEMBERSHIP", usualDay: "USUAL_DAY", appVersion: "APP_VERSION",
};
const KEY_OF = Object.fromEntries(Object.entries(TYPE).map(([k, t]) => [t, k])) as Record<string, FilterKey>;
const DATE_OP: Partial<Record<FilterOp, string>> = { before: "BEFORE", since: "SINCE", between: "BETWEEN" };
const ids = (xs: number[]) => [...new Set(xs)].sort((x, y) => x - y);
// One row as the backend takes it. Only the fields its op uses are sent (the backend rejects nothing extra, but a
// stored filter reads back exactly as sent this way).
export function toContract(r: FilterRow): ContractFilter {
  const type = TYPE[r.key];
  switch (r.key) {
    case "city": return { type, op: r.op === "isNotAnyOf" ? "NOT_IN" : "IN", cityIds: ids(r.ids) };
    case "playedAt": case "neverPlayedAt": case "homeField": return { type, fieldIds: ids(r.ids) };
    case "lastPlayed": case "firstPlayed": case "signedUp":
      if (r.op === "between") return { type, op: "BETWEEN", from: r.date, to: r.date2 };
      if (r.op === "moreThanDaysAgo") return { type, op: "MORE_THAN_DAYS", days: r.n };
      if (r.op === "withinDays") return { type, op: "WITHIN_DAYS", days: r.n };
      if (r.op === "never") return { type, op: "NEVER" };
      return { type, op: DATE_OP[r.op], date: r.date };
    case "upcomingBooking": return { type, value: r.op === "yes" };
    case "matchesPlayed":
      return r.op === "atLeast" ? { type, op: "AT_LEAST", min: r.n } : r.op === "atMost" ? { type, op: "AT_MOST", max: r.n } : { type, op: "BETWEEN", min: r.n, max: r.n2 };
    case "matchesLast30": return { type, op: r.op === "atMost" ? "AT_MOST" : "AT_LEAST", count: r.n };
    case "neverPlayed": return { type };
    case "freeFirstMatch": return { type, used: r.op === "used" };
    case "membership": case "usualDay": return { type, value: r.choice };
    case "appVersion": return { type, min: r.text?.trim() || "1.88" };
  }
}
// A stored filter back into a row. A type this page doesn't know is kept as an unknown row would be lost on the next
// save, so it is returned as null and the caller says so (unknownFilters).
export function fromContract(f: ContractFilter, i: number): FilterRow | null {
  const key = KEY_OF[f.type];
  if (!key) return null;
  const r: FilterRow = { id: `s${i}`, key, op: filterDef(key).ops[0].op, ids: [], date: null, date2: null, n: null, n2: null, choice: null, text: null };
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  switch (key) {
    case "city": return { ...r, op: f.op === "NOT_IN" ? "isNotAnyOf" : "isAnyOf", ids: (f.cityIds as number[]) ?? [] };
    case "playedAt": case "neverPlayedAt": case "homeField": return { ...r, ids: (f.fieldIds as number[]) ?? [] };
    case "lastPlayed": case "firstPlayed": case "signedUp":
      if (f.op === "BETWEEN") return { ...r, op: "between", date: str(f.from), date2: str(f.to) };
      if (f.op === "MORE_THAN_DAYS") return { ...r, op: "moreThanDaysAgo", n: num(f.days) };
      if (f.op === "WITHIN_DAYS") return { ...r, op: "withinDays", n: num(f.days) };
      if (f.op === "NEVER") return { ...r, op: "never" };
      return { ...r, op: f.op === "SINCE" ? "since" : "before", date: str(f.date) };
    case "upcomingBooking": return { ...r, op: f.value === false ? "no" : "yes" };
    case "matchesPlayed": return f.op === "AT_MOST" ? { ...r, op: "atMost", n: num(f.max) } : f.op === "BETWEEN" ? { ...r, op: "between", n: num(f.min), n2: num(f.max) } : { ...r, op: "atLeast", n: num(f.min) };
    case "matchesLast30": return { ...r, op: f.op === "AT_MOST" ? "atMost" : "atLeast", n: num(f.count) };
    case "neverPlayed": return r;
    case "freeFirstMatch": return { ...r, op: f.used === false ? "notUsed" : "used" };
    case "membership": case "usualDay": return { ...r, choice: str(f.value) };
    case "appVersion": return { ...r, text: str(f.min) ?? "1.88" };
  }
}
export const audienceOf = (s: AudienceSpec, playerIds: number[]): ContractAudience =>
  s.mode === "PLAYERS" ? { mode: "PLAYERS", playerIds: ids(playerIds) } : { mode: "FILTERS", filters: s.filters.map(toContract) };
export function specOfAudience(a: ContractAudience | null | undefined, playersText = ""): { spec: AudienceSpec; unknown: number } {
  if (!a) return { spec: emptySpec(), unknown: 0 };
  if (a.mode === "PLAYERS") return { spec: { mode: "PLAYERS", filters: [], playersText: playersText || a.playerIds.join(", ") }, unknown: 0 };
  const rows = a.filters.map(fromContract);
  return { spec: { mode: "FILTERS", filters: rows.filter((r): r is FilterRow => r !== null), playersText }, unknown: rows.filter((r) => r === null).length };
}
// The same audience whatever order its keys and ids came back in: what a read-back is compared on.
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") ? [...v].sort((x, y) => (x as number) - (y as number)) : v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== null).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
  return v;
}
export const canonicalAudience = (a: unknown) => JSON.stringify(sortDeep(a ?? null));

// ── EXACT PLAYERS (20835:230) ──────────────────────────────────────────────────────────────────
// What was pasted, split the way the backend's lookup wants it (commas, semicolons and new lines), each entry once.
export function entriesOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;]+/)) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out;
}
// POST /admin/audiences/players/lookup: { players: [{ id, name, allowPushes, entry }], notFound: [entry] }.
export type FoundPlayer = { id: number; name: string | null; allowPushes?: boolean | null; entry?: string; city?: string | null };
export type TokenLookup = { players: FoundPlayer[]; notFound: string[] };
export const MAX_ENTRIES = 20000;
// "#78 Ryan M." on a tag. The backend already sends first name and last initial; a full name is shortened the same way.
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
  const allow = players.filter((p) => p.allowPushes === true).length;
  const known = players.some((p) => typeof p.allowPushes === "boolean");
  return `${n.toLocaleString("en-US")} ${n === 1 ? "player" : "players"}${known ? ` · ${allow.toLocaleString("en-US")} allow pushes` : ""}`;
}

// ── THE COUNT BAR (20835:156) ─────────────────────────────────────────────────────────────────
// POST /admin/audiences/count: { matching, allowPushes, on188, holdoutPercent, heldBack, willSend }.
// "412 players match · 338 allow pushes · 10% held back to measure". allowPushes is left out where the host's count
// has no such column (Offers on a backend from before the shared audience).
// atCap / weeklyCap (backend e9e90a7): of allowPushes, players already at the weekly cap, who a push now skips; then
// heldBack is the holdout of the rest and willSend = allowPushes - atCap - heldBack. Absent on a backend before it.
export type ContractCount = { matching: number; allowPushes: number; on188?: number; atCap?: number; weeklyCap?: number; holdoutPercent: number; heldBack: number; willSend: number };
export function countLine(c: { matching: number; allowPushes?: number | null; holdoutPercent: number }): string {
  const parts = [`${c.matching.toLocaleString("en-US")} ${c.matching === 1 ? "player matches" : "players match"}`];
  if (typeof c.allowPushes === "number") parts.push(`${c.allowPushes.toLocaleString("en-US")} allow pushes`);
  if (c.holdoutPercent > 0) parts.push(`${c.holdoutPercent}% held back to measure`);
  return parts.join(" · ");
}
// The amber flag under it (Figma 20842:72): "38 already got 3 pushes this week and won't get this one."
export const capFlagLine = (capped: number, cap: number) =>
  `${capped.toLocaleString("en-US")} already ${capped === 1 ? "has" : "got"} ${cap} ${cap === 1 ? "push" : "pushes"} this week and won't get this one.`;

// ── OFFERS ──────────────────────────────────────────────────────────────────────────────────────
// What the Offers backend takes (M3-ENDPOINTS "Audience"): cities (any of), played at, last played as more than N
// days ago or never, matches played, membership member / not. Anything else is not offered on that page.
export const OFFERS_FILTERS: Allowed = {
  city: ["isAnyOf"], playedAt: ["anyOf"], lastPlayed: ["moreThanDaysAgo", "never"], matchesPlayed: ["atLeast", "atMost", "between"], membership: ["is"],
};
export const OFFERS_HINTS: Partial<Record<FilterKey, string>> = { city: "is any of", lastPlayed: "more than N days ago / never", membership: "member / not" };
export const OFFERS_MEMBERSHIP = [{ value: "MEMBER", label: "Member" }, { value: "NOT_MEMBER", label: "Not a member" }];
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
  if (a.membership !== "ANYONE") rows.push(row("membership", "is", { choice: a.membership === "MEMBERS" ? "MEMBER" : "NOT_MEMBER" }));
  return { mode: a.audienceMode, filters: rows, playersText: a.playerIdsText };
}
// Back to the Offers form's own fields. A row the Offers backend can't take (none can be added on that page, but a
// row could be edited into one) falls back to the nearest it can: a between with no top is at least, and so on.
export function offerOfSpec(s: AudienceSpec): Omit<OfferAudience, "playerIdsText"> & { playerIdsText: string } {
  const out = { audienceMode: s.mode, cityIds: [] as number[], fieldIds: [] as number[], lastPlayed: "ANY" as LastPlayed, lastPlayedDays: null as number | null, minMatches: 0, maxMatches: null as number | null, membership: "ANYONE" as Membership, playerIdsText: s.playersText };
  for (const r of s.filters) {
    if (r.key === "city") out.cityIds = [...r.ids];
    else if (r.key === "playedAt") out.fieldIds = [...r.ids];
    else if (r.key === "neverPlayed") out.lastPlayed = "NEVER";
    else if (r.key === "lastPlayed") { if (r.op === "never") out.lastPlayed = "NEVER"; else { out.lastPlayed = "LAPSED"; out.lastPlayedDays = r.n ?? 30; } }
    else if (r.key === "matchesPlayed") {
      if (r.op === "atLeast") { out.minMatches = r.n ?? 0; out.maxMatches = null; }
      else if (r.op === "atMost") { out.minMatches = 0; out.maxMatches = r.n; }
      else { out.minMatches = r.n ?? 0; out.maxMatches = r.n2; }
    } else if (r.key === "membership") out.membership = r.choice === "MEMBER" ? "MEMBERS" : r.choice === "NOT_MEMBER" || r.choice === "FORMER_MEMBER" ? "NON_MEMBERS" : "ANYONE";
  }
  return out;
}
