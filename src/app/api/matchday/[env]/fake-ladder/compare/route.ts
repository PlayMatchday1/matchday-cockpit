/* BEFORE / AFTER THE NEW FAKE LADDER — GET /api/matchday/production/fake-ladder/compare
 *
 * READS THE MIRROR ONLY. No MatchDay request: these are completed matches, and mdapi_matches /
 * mdapi_match_players / mdapi_reviews hold them. The six numbers and how each is computed are in
 * src/lib/fakeLadderCompare.ts.
 *
 * ── THE TWO WINDOWS ───────────────────────────────────────────────────────────────────────────
 * THE SWITCH is the earliest production row in fake_ladder_switches (the 'defaults' row migration
 * 0231 writes, or the first bulk run). BEFORE is the 28 days of kickoffs up to it. AFTER starts 36
 * hours after it — the bulk action only rewrites matches more than 36h out, so anything kicking off
 * sooner ran on the old ladder — and runs to two hours ago, so a match is finished before it counts.
 * AFTER also says how many of its matches actually carry the new ladder today, because a match
 * changed by hand or skipped did not.
 *
 * WARSAW IS EXCLUDED (Ryan, 2026-10-23). A confined account sees its own city only, pushed into the
 * query as the gate requires.
 */
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { cohortStats, type CmpMatch, type CmpRow, type CmpReview } from "@/lib/fakeLadderCompare";
import { newDefaultLadder, RUNG_KEYS } from "@/lib/fakeLadder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY = 86_400_000;
const BEFORE_DAYS = 28;

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  // The mirror holds production ids only.
  if (env !== "production") return Response.json({ error: "the comparison reads the production mirror" }, { status: 400 });
  const sb = auth.supabase;

  try {
    const sw = await sb.from("fake_ladder_switches").select("started_at").eq("env", "production")
      .order("started_at", { ascending: true }).limit(1);
    const switchAt = !sw.error && sw.data?.[0]?.started_at ? Date.parse(sw.data[0].started_at) : null;
    const now = Date.now();
    const end = now - 2 * 3_600_000;
    const beforeEnd = switchAt ?? end;
    const windows = {
      before: { from: beforeEnd - BEFORE_DAYS * DAY, to: beforeEnd },
      after: switchAt ? { from: switchAt + 36 * 3_600_000, to: end } : null,
    };

    const loadMatches = async (from: number, to: number) => {
      const out: (CmpMatch & { ladder: Record<string, unknown> })[] = [];
      if (to <= from) return out;
      for (let f = 0; ; f += 1000) {
        let q = sb.from("mdapi_matches")
          .select("api_id, city_name, field_title, start_date, start_date_utc, updated_at, is_cancelled, min_player_count, max_player_count, auto_canceled_minutes, fake_player_count, r36:raw->fakeSpotLeft36h, r24:raw->fakeSpotLeft24h, r12:raw->fakeSpotLeft12h, r6:raw->fakeSpotLeft6h, r3:raw->fakeSpotLeft3h")
          .gte("start_date_utc", new Date(from).toISOString()).lt("start_date_utc", new Date(to).toISOString())
          .is("deleted_at", null).gt("max_player_count", 0).neq("city_name", "Warsaw");
        if (auth.confinedCity) q = q.eq("city_identifier", auth.confinedCity);
        const { data, error } = await q.order("api_id").range(f, f + 999);
        if (error) throw new Error(`matches: ${error.message}`);
        for (const m of (data ?? []) as Record<string, unknown>[]) {
          out.push({
            ...(m as unknown as CmpMatch), rung3h: m.r3 == null ? null : Number(m.r3),
            ladder: { fakeSpotLeft36h: m.r36, fakeSpotLeft24h: m.r24, fakeSpotLeft12h: m.r12, fakeSpotLeft6h: m.r6, fakeSpotLeft3h: m.r3 },
          });
        }
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    const loadRows = async (ids: number[]) => {
      const by = new Map<number, CmpRow[]>();
      for (let i = 0; i < ids.length; i += 150) {
        for (let f = 0; ; f += 1000) {
          const { data, error } = await sb.from("mdapi_match_players")
            .select("match_api_id, user_is_fake_player, paid_status, created_at, canceled_at, deleted_at, user_status, is_absent")
            .in("match_api_id", ids.slice(i, i + 150)).order("api_id").range(f, f + 999);
          if (error) throw new Error(`rosters: ${error.message}`);
          for (const r of (data ?? []) as CmpRow[]) (by.get(r.match_api_id) ?? by.set(r.match_api_id, []).get(r.match_api_id)!).push(r);
          if (!data || data.length < 1000) break;
        }
      }
      return by;
    };
    const loadReviews = async (from: number, to: number) => {
      const out: CmpReview[] = [];
      if (to <= from) return out;
      // A day of slack each side: review start_date is wall clock, the window is instants.
      for (let f = 0; ; f += 1000) {
        const { data, error } = await sb.from("mdapi_reviews").select("field_title, start_date, star_rating")
          .gte("start_date", new Date(from - DAY).toISOString()).lt("start_date", new Date(to + DAY).toISOString())
          .order("api_id").range(f, f + 999);
        if (error) throw new Error(`reviews: ${error.message}`);
        out.push(...((data ?? []) as CmpReview[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    };

    const side = async (w: { from: number; to: number } | null) => {
      if (!w || w.to <= w.from) return null;
      const ms = await loadMatches(w.from, w.to);
      const [rows, reviews] = await Promise.all([loadRows(ms.map((m) => m.api_id)), loadReviews(w.from, w.to)]);
      const onNew = ms.filter((m) => {
        const d = newDefaultLadder(m.max_player_count);
        return !!d && RUNG_KEYS.every((k) => m.ladder[k] != null && Number(m.ladder[k]) === d[k]);
      }).length;
      return { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), onNewLadder: onNew, ...cohortStats(ms, rows, reviews) };
    };

    const [before, after] = [await side(windows.before), await side(windows.after)];
    return Response.json({
      switchAt: switchAt ? new Date(switchAt).toISOString() : null,
      switchError: sw.error ? sw.error.message : null,
      before, after, confined: !!auth.confinedCity,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
