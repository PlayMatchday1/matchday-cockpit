/* THE ONE-OFF "APPLY FIXED LADDER" — PREVIEW ONLY.
 *
 *   GET /api/matchday/{env}/fixed-ladder   every upcoming match from FIXED_LADDER_FROM (Nov 2), and
 *                                          what the fixed ladder would change on it
 *
 * THE WRITES ARE NOT HERE. Each match is written by /fixed-ladder/{id}, one request per match from
 * the card, so the run is paced, stops at the first write that does not land, and survives past a
 * function's time limit. This route sends nothing.
 *
 * READ LIVE, NOT FROM THE MIRROR. The mirror's ladder is as old as its last sync and does not see a
 * Retool edit. The admin list carries the five rungs, the capacity, startDate, startDateUtc and
 * isCancelled, so the preview is planFixedLadder over the live list — the SAME function the write
 * route runs again on a fresh read immediately before writing.
 *
 * PAGED AT ONE REQUEST PER TWO SECONDS (the standing rule for production sweeps). About three pages.
 *
 * A confined account is held to its own city; the write route re-checks each match with
 * assertMatchInScope anyway.
 */
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { cityNameFor } from "@/lib/cityScope";
import { planFixedLadder, FIXED_LADDER_FROM, RUNG_KEYS, type FixedLadderStatus } from "@/lib/fakeLadder";
import { handEditsFor } from "@/lib/fakeLadderHandEdits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const PAGE_LIMIT = 100;
const PAGE_PAUSE_MS = 2000;
/** How far ahead the preview looks. Matches are scheduled about five weeks out; 70 days is margin. */
const AHEAD_DAYS = 70;

type Raw = Record<string, unknown>;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FixedLadderRow = {
  id: number; name: string; city: string | null; field: string | null;
  /** WALL CLOCK, as the API stores it — printed, never parsed into a Date. */
  startDate: string; hoursToKickoff: number | null; capacity: number | null;
  current: Record<string, number | null>; target: Record<string, number> | null;
  status: FixedLadderStatus;
  /** For a hand-edited match: the most recent hand change, as evidence. */
  handEdit: { source: string; at: string } | null;
};

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const city = auth.confinedCity ? cityNameFor(auth.confinedCity) : null;

  try {
    const now = Date.now();
    /* ONE DAY OF SLACK EACH SIDE of the start date: the list filters on calendar dates and its
     * basis is not proven. The plan decides on the match's own wall-clock day. */
    const fromMs = Math.max(now, Date.parse(`${FIXED_LADDER_FROM}T00:00:00Z`)) - 86_400_000;
    const raw: Raw[] = [];
    for (let page = 1; page <= 20; page++) {
      if (page > 1) await sleep(PAGE_PAUSE_MS);
      const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, "/admin/matches", {
        fromDate: ymd(fromMs), toDate: ymd(now + AHEAD_DAYS * 86_400_000),
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
    // A match that moves while the pages are read can arrive twice. Counted once.
    const seen = new Set<number>();
    const scoped = raw.filter((m) => {
      const id = Number(m.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return !city || cityOf(m) === city;
    });
    /* HAND EDITS, from change_log. A failed read is an ERROR, never "nobody edited anything" —
     * that would put hand-set ladders in the write set. */
    const hand = await handEditsFor(auth.supabase, env, scoped.map((m) => Number(m.id)));
    if (!hand.ok) return Response.json({ error: `Couldn't check for hand edits, so nothing is counted: ${hand.error}` }, { status: 500 });

    const rows: FixedLadderRow[] = scoped
      .map((m) => {
        const edit = hand.byMatch.get(Number(m.id)) ?? null;
        const plan = planFixedLadder(m, now, { handEdited: !!edit });
        const f = (m.field ?? {}) as Raw;
        const current: Record<string, number | null> = {};
        for (const k of RUNG_KEYS) current[k] = m[k] == null ? null : Number(m[k]);
        return {
          id: Number(m.id), name: String(m.name ?? ""), city: cityOf(m),
          field: ((f.title as string | undefined) ?? "").trim() || null,
          startDate: String(m.startDate ?? ""), hoursToKickoff: plan.hoursToKickoff,
          capacity: m.maxPlayerCount == null ? null : Number(m.maxPlayerCount),
          current, target: plan.target, status: plan.status,
          handEdit: plan.status === "handEdited" ? edit : null,
        };
      })
      // The slack day before the start date is not part of the scope; it is dropped, not listed.
      .filter((r) => r.status !== "beforeFrom")
      .sort((a, b) => (a.hoursToKickoff ?? Infinity) - (b.hoursToKickoff ?? Infinity));

    const counts: Record<FixedLadderStatus, number> = { change: 0, unchanged: 0, beforeFrom: 0, inside36h: 0, handEdited: 0, cancelled: 0, nocap: 0 };
    for (const r of rows) counts[r.status]++;

    return Response.json({
      env, city, from: FIXED_LADDER_FROM, rows, counts, fetched: raw.length,
      checkedAt: new Date(now).toISOString(), canWrite: auth.canEditMatches,
    });
  } catch (e) {
    if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
