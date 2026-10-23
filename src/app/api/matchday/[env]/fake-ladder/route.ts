/* THE NEW FAKE LADDER — PREVIEW, AND THE RECORD OF EACH SWITCH.
 *
 *   GET  /api/matchday/{env}/fake-ladder?city=<name>   every upcoming match, what the new ladder
 *                                                        would change on it, and the switch history
 *   POST /api/matchday/{env}/fake-ladder                { action: "start" | "finish", ... }
 *
 * THE WRITES ARE NOT HERE. Each match is written by /fake-ladder/{id}, one request per match from
 * the page, so the run can be paced at one MatchDay request per second, stop at the first write that
 * does not land, and survive past a function's time limit. This route only says what WOULD change
 * and records when a run started and how it ended.
 *
 * ── THE PREVIEW IS READ LIVE, NOT FROM THE MIRROR ────────────────────────────────────────────────
 * The mirror's ladder is as old as its last sync and does not see a Retool edit, so a count taken
 * from it could be wrong in either direction. The admin list carries the five rungs, the capacity,
 * startDateUtc and isCancelled (gamedayApiShape reads the same fields off it), so the preview is
 * planNewLadder over the live list — the SAME function the write route runs again on a fresh read
 * immediately before writing.
 *
 * PAGED AT ONE REQUEST PER SECOND. Upcoming matches are about 220 across every city (2026-10-23),
 * three pages of 100. A second's pause between pages keeps a preview inside the scheduled-job rate
 * and costs three seconds.
 *
 * ── CITY ──────────────────────────────────────────────────────────────────────────────────────
 * The admin list takes no city parameter (see gameday/route.ts), so the city filter is applied
 * here, after the fetch, and nothing is counted before it. A confined account is held to its own
 * city whatever it asks for; the write route re-checks each match with assertMatchInScope anyway.
 */
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { cityNameFor } from "@/lib/cityScope";
import { planNewLadder, RUNG_KEYS, type NewLadderStatus } from "@/lib/fakeLadder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const PAGE_LIMIT = 100;
const PAGE_PAUSE_MS = 1000;
/** How far ahead the preview looks. Matches are scheduled about five weeks out; 70 days is margin. */
const AHEAD_DAYS = 70;

type Raw = Record<string, unknown>;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LadderPreviewRow = {
  id: number; name: string; city: string | null; field: string | null;
  /** WALL CLOCK, as the API stores it — printed, never parsed into a Date. */
  startDate: string; hoursToKickoff: number | null; capacity: number | null;
  current: Record<string, number | null>; target: Record<string, number> | null;
  status: NewLadderStatus;
};

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const asked = new URL(req.url).searchParams.get("city")?.trim() || null;
  const city = auth.confinedCity ? cityNameFor(auth.confinedCity) : asked;

  try {
    const now = Date.now();
    const raw: Raw[] = [];
    for (let page = 1; page <= 20; page++) {
      if (page > 1) await sleep(PAGE_PAUSE_MS);
      const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, "/admin/matches", {
        // ONE DAY OF SLACK BEHIND: the list filters on calendar dates, and a match tonight in
        // Central is tomorrow in UTC. Anything already past its 3h mark is skipped by the plan.
        fromDate: ymd(now - 86_400_000), toDate: ymd(now + AHEAD_DAYS * 86_400_000),
        page, limit: PAGE_LIMIT, sortColumn: "startDateUtc", sortDirection: "asc",
      });
      const rows = Array.isArray(res) ? (res as Raw[]) : (res.data ?? []);
      raw.push(...rows);
      const total = Array.isArray(res) ? rows.length : (res.totalItems ?? rows.length);
      if (rows.length < PAGE_LIMIT || raw.length >= total) break;
    }

    const cityOf = (m: Raw) => {
      const f = (m.field ?? {}) as Raw;
      return (((f.city ?? {}) as Raw).name as string | undefined) ?? null;
    };
    /* THE CITY LIST comes from what the API returned, before the filter, so the selector offers
     * every city that has an upcoming match — and only those. */
    const cities = [...new Set(raw.map(cityOf).filter((c): c is string => !!c))].sort();

    const rows: LadderPreviewRow[] = raw
      .filter((m) => !city || cityOf(m) === city)
      .map((m) => {
        const plan = planNewLadder(m, now);
        const f = (m.field ?? {}) as Raw;
        const current: Record<string, number | null> = {};
        for (const k of RUNG_KEYS) current[k] = m[k] == null ? null : Number(m[k]);
        return {
          id: Number(m.id), name: String(m.name ?? ""), city: cityOf(m),
          field: ((f.title as string | undefined) ?? "").trim() || null,
          startDate: String(m.startDate ?? ""), hoursToKickoff: plan.hoursToKickoff,
          capacity: m.maxPlayerCount == null ? null : Number(m.maxPlayerCount),
          current, target: plan.target, status: plan.status,
        };
      })
      // Soonest first, by the TRUE instant the plan already computed.
      .sort((a, b) => (a.hoursToKickoff ?? Infinity) - (b.hoursToKickoff ?? Infinity));

    const counts: Record<NewLadderStatus, number> = { change: 0, unchanged: 0, past3h: 0, cancelled: 0, nocap: 0 };
    for (const r of rows) counts[r.status]++;

    const sw = await auth.supabase.from("fake_ladder_switches")
      .select("id, kind, env, scope_city, actor_email, started_at, finished_at, previewed, landed, unchanged, skipped, not_landed, stopped_reason")
      .eq("env", env).order("started_at", { ascending: false }).limit(50);

    return Response.json({
      env, city, confined: !!auth.confinedCity, cities, rows, counts,
      checkedAt: new Date(now).toISOString(), canWrite: auth.canEditMatches,
      switches: sw.data ?? [],
      // AN UNMIGRATED TABLE IS SAID, NOT HIDDEN. The page refuses to start a run without it.
      switchesError: sw.error ? sw.error.message : null,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/* ── START AND FINISH ─────────────────────────────────────────────────────────────────────────
 * START is recorded BEFORE the first write and refuses if it cannot be: the switch date is the
 * point of the run, so a run that could not record when it started would produce exactly the
 * before/after confusion this table exists to prevent. FINISH records the tally; if the browser
 * closes mid-run, finished_at stays null and the change_log rows (save_id ladder-<id>-<match>)
 * are the exact record. */
export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!auth.canEditMatches) return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });

  const b = (await req.json().catch(() => null)) as Raw | null;
  if (!b) return Response.json({ error: "body required" }, { status: 400 });
  const int = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

  if (b.action === "start") {
    const asked = typeof b.city === "string" && b.city.trim() ? b.city.trim() : null;
    const scope = auth.confinedCity ? cityNameFor(auth.confinedCity) : asked;
    const previewed = int(b.previewed);
    if (previewed == null || previewed <= 0) return Response.json({ error: "previewed (the confirmed count) is required" }, { status: 400 });
    const { data, error } = await auth.supabase.from("fake_ladder_switches")
      .insert({ kind: "bulk", env, scope_city: scope, actor_email: auth.email, previewed })
      .select("id, started_at").single();
    if (error || !data) {
      return Response.json({ error: `Could not record the switch, so nothing was written: ${error?.message ?? "no row"}. Has migration 0231 been applied?` }, { status: 500 });
    }
    return Response.json({ id: data.id, startedAt: data.started_at, scope });
  }

  if (b.action === "finish") {
    const id = int(b.id);
    if (id == null) return Response.json({ error: "id required" }, { status: 400 });
    const { error } = await auth.supabase.from("fake_ladder_switches").update({
      finished_at: new Date().toISOString(),
      landed: int(b.landed), unchanged: int(b.unchanged), skipped: int(b.skipped), not_landed: int(b.notLanded),
      stopped_reason: typeof b.stoppedReason === "string" && b.stoppedReason ? b.stoppedReason.slice(0, 500) : null,
    }).eq("id", id).eq("actor_email", auth.email).is("finished_at", null);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "action must be start or finish" }, { status: 400 });
}
