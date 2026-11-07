import "server-only"; // no-op under --conditions=react-server
// CHANGE LOG 2.0 — the server half of GET /api/changelog (Ryan 2026-11-07: search, Person, Area,
// outcome and date are all applied on the server, with "Load older" paging).
//
// It reads every change_log row in the date range (the old page read only the latest 500 of 14,005),
// groups them by save (changeLogModel.groupBySave, unchanged), looks up the names a sentence needs
// (app_users, mdapi_users, crm_threads, mdapi_matches — our own database, no MatchDay call), turns
// them into page rows (changeLogPresent), then filters, counts and pages. TEST rows (env staging) are
// listed under All but left out of every count; Syncs are hidden unless asked for.

import type { SupabaseClient } from "@supabase/supabase-js";
import { groupBySave, type LogRow, type LogState, type Change } from "@/lib/changeLogModel";
import { collapse, present, searchText, AREAS, type Enrich, type Item } from "@/lib/changeLogPresent";

export type ChangeLogQuery = {
  from: string | null; before: string | null; q: string; person: string; area: string;
  outcome: "all" | "needs" | "failed"; syncs: boolean; tz: string; limit: number;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function parseChangeLogQuery(u: URL): ChangeLogQuery {
  const g = (k: string) => u.searchParams.get(k) ?? "";
  const tz = g("tz");
  let okTz = "America/Chicago";
  try { if (tz) { new Intl.DateTimeFormat("en-US", { timeZone: tz }); okTz = tz; } } catch { /* keep Chicago */ }
  const outcome = g("outcome");
  const limit = Number(g("limit"));
  return {
    from: ISO.test(g("from")) ? g("from") : null,
    before: ISO.test(g("before")) ? g("before") : null,
    q: g("q").trim().toLowerCase().slice(0, 120),
    person: g("person").slice(0, 200) || "all",
    area: (AREAS as readonly string[]).includes(g("area")) ? g("area") : "all",
    outcome: outcome === "needs" || outcome === "failed" ? outcome : "all",
    syncs: g("syncs") === "1",
    tz: okTz,
    limit: Number.isFinite(limit) && limit >= 10 && limit <= 200 ? limit : 60,
  };
}

const COLS = "id, save_id, created_at, actor_name, actor_email, source, env, match_id, match_name, method, endpoint, request_body, outcome, server_said, changes, resolved, resolved_by, resolved_at";
const MAX_ROWS = 30_000;

async function loadRows(sb: SupabaseClient, from: string | null): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  for (let off = 0; off < MAX_ROWS; off += 1000) {
    let q = sb.from("change_log").select(COLS).order("created_at", { ascending: false }).range(off, off + 999);
    if (from) q = q.gte("created_at", from);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Record<string, unknown>[]) rows.push({
      id: String(r.id), saveId: r.save_id as string, at: r.created_at as string,
      actorName: (r.actor_name as string) ?? "", actorEmail: (r.actor_email as string) ?? null,
      source: r.source as string, env: r.env as string, matchId: (r.match_id as number) ?? null,
      matchName: (r.match_name as string) ?? null, method: r.method as string, endpoint: r.endpoint as string,
      body: (r.request_body as Record<string, unknown>) ?? {}, outcome: r.outcome as LogState,
      serverSaid: (r.server_said as string) ?? null, changes: (r.changes as Change[]) ?? [],
      resolved: (r.resolved as "yes" | "no") ?? null, resolvedBy: (r.resolved_by as string) ?? null, resolvedAt: (r.resolved_at as string) ?? null,
    });
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

const chunks = <T,>(xs: T[], n = 300) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function loadEnrich(sb: SupabaseClient, rows: LogRow[]): Promise<Enrich> {
  const en: Enrich = { staffByEmail: {}, staffById: {}, players: {}, threads: {}, matches: {} };
  const staff = await sb.from("app_users").select("id, email, full_name");
  for (const u of (staff.data ?? []) as { id: string; email: string | null; full_name: string | null }[]) {
    if (u.email) en.staffByEmail[u.email.toLowerCase()] = u.full_name ?? "";
    en.staffById[u.id] = { email: u.email ?? "", name: u.full_name };
  }
  const playerIds = new Set<string>(), threadIds = new Set<string>(), matchIds = new Set<string>();
  for (const r of rows) {
    const e = r.endpoint;
    for (const rx of [/^\/admin\/players\/(\d+)\/profile/, /^\/admin\/matches\/\d+\/players\/(\d+)$/, /\/subscriptions\/users\/(\d+)/]) { const m = rx.exec(e); if (m) playerIds.add(m[1]); }
    const uid = r.body?.userId;
    if (typeof uid === "number" || (typeof uid === "string" && /^\d+$/.test(uid))) playerIds.add(String(uid));
    if (typeof r.body?.thread_id === "string") threadIds.add(r.body.thread_id);
    if (r.matchId != null) matchIds.add(String(r.matchId));
  }
  for (const part of chunks([...threadIds])) {
    const t = await sb.from("crm_threads").select("id, player_id").in("id", part);
    for (const x of (t.data ?? []) as { id: string; player_id: number | null }[]) {
      en.threads[x.id] = null;
      if (x.player_id != null) playerIds.add(String(x.player_id));
    }
  }
  for (const part of chunks([...playerIds])) {
    const p = await sb.from("mdapi_users").select("id, first_name, last_name").in("id", part.map(Number));
    for (const x of (p.data ?? []) as { id: number; first_name: string | null; last_name: string | null }[]) {
      const n = `${x.first_name ?? ""} ${x.last_name ?? ""}`.trim();
      if (n) en.players[String(x.id)] = n;
    }
  }
  // the thread → player name, now the names are in
  if (threadIds.size) {
    for (const part of chunks([...threadIds])) {
      const t = await sb.from("crm_threads").select("id, player_id").in("id", part);
      for (const x of (t.data ?? []) as { id: string; player_id: number | null }[]) en.threads[x.id] = x.player_id != null ? en.players[String(x.player_id)] ?? null : null;
    }
  }
  for (const part of chunks([...matchIds])) {
    const m = await sb.from("mdapi_matches").select("api_id, field_title, name, start_date").in("api_id", part.map(Number));
    for (const x of (m.data ?? []) as { api_id: number; field_title: string | null; name: string | null; start_date: string | null }[]) {
      en.matches[String(x.api_id)] = { field: x.field_title, name: x.name, start: x.start_date };
    }
  }
  return en;
}

export type ChangeLogPage = {
  items: Item[];
  counts: { all: number; needs: number; failed: number };
  people: { key: string; name: string; initials: string; system: boolean; n: number }[];
  areas: { area: string; n: number }[];
  dayCounts: Record<string, number>;
  nextBefore: string | null;
  scannedRows: number; from: string | null; tz: string;
};

export const ymdIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** The filters, apart from the I/O, so the test can run them on fixtures. */
export function shapePage(all: Item[], q: ChangeLogQuery, scannedRows: number): ChangeLogPage {
  const visibleBase = all.filter((it) => q.syncs || !it.sync);
  const byPerson = (it: Item) => q.person === "all" || it.actor.key === q.person;
  const byArea = (it: Item) => q.area === "all" || it.area === q.area;
  const bySearch = (it: Item) => !q.q || searchText(it).includes(q.q);
  const counted = (it: Item) => !it.test; // TEST rows are never counted
  const base = visibleBase.filter((it) => byPerson(it) && byArea(it) && bySearch(it));
  const counts = {
    all: base.filter(counted).length,
    needs: base.filter((it) => counted(it) && it.needs).length,
    failed: base.filter((it) => counted(it) && it.outcome === "failed").length,
  };
  const peopleMap = new Map<string, ChangeLogPage["people"][number]>();
  for (const it of visibleBase.filter((x) => counted(x) && byArea(x) && bySearch(x))) {
    const p = peopleMap.get(it.actor.key) ?? { ...it.actor, n: 0 };
    p.n++; peopleMap.set(it.actor.key, p);
  }
  const areaMap = new Map<string, number>();
  for (const it of visibleBase.filter((x) => counted(x) && byPerson(x) && bySearch(x))) areaMap.set(it.area, (areaMap.get(it.area) ?? 0) + 1);
  const byOutcome = (it: Item) => q.outcome === "all" || (!it.test && (q.outcome === "needs" ? it.needs : it.outcome === "failed"));
  const matching = base.filter(byOutcome);
  const dayCounts: Record<string, number> = {};
  for (const it of matching) if (counted(it)) { const k = ymdIn(it.at, q.tz); dayCounts[k] = (dayCounts[k] ?? 0) + 1; }
  const older = q.before ? matching.filter((it) => it.at < q.before!) : matching;
  const items = older.slice(0, q.limit);
  return {
    items, counts,
    people: [...peopleMap.values()].sort((a, b) => b.n - a.n),
    areas: [...areaMap].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n),
    dayCounts,
    nextBefore: older.length > items.length ? items[items.length - 1]?.at ?? null : null,
    scannedRows, from: q.from, tz: q.tz,
  };
}

export async function runChangeLogQuery(sb: SupabaseClient, q: ChangeLogQuery): Promise<ChangeLogPage> {
  const rows = await loadRows(sb, q.from);
  const en = await loadEnrich(sb, rows);
  const emailBySave: Record<string, string | null> = {};
  for (const r of rows) if (emailBySave[r.saveId] == null) emailBySave[r.saveId] = r.actorEmail ?? null;
  const items = collapse(present(groupBySave(rows), en, emailBySave), en);
  return shapePage(items, q, rows.length);
}
