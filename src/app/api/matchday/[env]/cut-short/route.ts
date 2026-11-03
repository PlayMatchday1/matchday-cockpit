// MATCHES CUT SHORT (Ryan, 2026-11-02) — the city manager marks a match that started and stopped early.
//
//   GET    /api/matchday/{env}/cut-short?ids=1,2,3   the marks for those matches (the board's day)
//   POST   /api/matchday/{env}/cut-short             { match_id, reason, minutes_played, note? }
//   DELETE /api/matchday/{env}/cut-short?match_id=1  remove a mark
//
// The MatchDay API has no field for this: the match is not cancelled and nobody was credited. The mark
// lives in match_cut_short (migration 0251) and Player Chats drafts read it: a player asking about a
// marked match is credited the match price like a match we cancelled (src/lib/aiDraftPolicy.ts).
//
// WHO. A city manager (the /city/gameday tier) for matches in their city. A Match Ops account with
// EDIT MATCHES, or an admin; a confined one only inside its city (assertMatchInScope). Read: anyone who
// can open either board. A mark changes what a match record says HAPPENED, so every write goes through
// recordWrite into change_log: read, write, read back, LANDED only when the read-back agrees.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCityManager } from "@/lib/cityManagerAuth";
import { authenticateMatchOpsRead, assertMatchInScope } from "@/lib/matchOpsAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { cutShortProblem, CUT_SHORT_LABEL, type CutShortReason } from "@/lib/aiDraftPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ env: string }> };
type Who = { supabase: SupabaseClient; appUserId: string; email: string; scopeCity: string | null; canWrite: boolean };

async function who(req: Request): Promise<{ ok: true; w: Who } | { ok: false; status: number; error: string }> {
  const cm = await authenticateCityManager(req);
  if (cm.ok) return { ok: true, w: { supabase: cm.supabase, appUserId: cm.appUserId, email: cm.email, scopeCity: cm.cityIdentifier, canWrite: true } };
  const mo = await authenticateMatchOpsRead(req);
  if (!mo.ok) return mo;
  return { ok: true, w: { supabase: mo.supabase, appUserId: mo.appUserId, email: mo.email, scopeCity: mo.confinedCity, canWrite: mo.isAdmin || mo.canEditMatches } };
}

const isEnv = (e: string): e is "production" | "staging" => e === "production" || e === "staging";

export async function GET(req: Request, ctx: Ctx) {
  const a = await who(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: "unknown environment" }, { status: 400 });
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);
  if (!ids.length) return Response.json({ marks: [] });
  let allowed = ids;
  if (a.w.scopeCity) {
    const m = await a.w.supabase.from("mdapi_matches").select("api_id").in("api_id", ids).eq("city_identifier", a.w.scopeCity);
    if (m.error) return Response.json({ error: "Could not verify the matches' city" }, { status: 500 });
    allowed = (m.data ?? []).map((r) => Number(r.api_id));
  }
  if (!allowed.length) return Response.json({ marks: [] });
  const r = await a.w.supabase.from("match_cut_short").select("match_id, reason, minutes_played, note, set_by_email, created_at").eq("env", env).in("match_id", allowed);
  if (r.error) return Response.json({ error: r.error.message }, { status: 500 });
  return Response.json({ marks: r.data ?? [] });
}

async function readMark(sb: SupabaseClient, env: string, matchId: number) {
  const r = await sb.from("match_cut_short").select("reason, minutes_played, note").eq("env", env).eq("match_id", matchId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return (r.data ?? {}) as { reason?: string; minutes_played?: number; note?: string | null };
}

export async function POST(req: Request, ctx: Ctx) {
  const a = await who(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  if (!a.w.canWrite) return Response.json({ error: "Marking a match cut short needs EDIT MATCHES." }, { status: 403 });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: "unknown environment" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { match_id?: unknown; reason?: unknown; minutes_played?: unknown; note?: unknown } | null;
  const matchId = Number(body?.match_id);
  if (!Number.isInteger(matchId) || matchId <= 0) return Response.json({ error: "match_id required" }, { status: 400 });
  const problem = cutShortProblem(body?.reason, body?.minutes_played, body?.note);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const scope = await assertMatchInScope(a.w.supabase, a.w.scopeCity, matchId, env);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  const reason = body!.reason as CutShortReason, minutes = body!.minutes_played as number;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  const m = await a.w.supabase.from("mdapi_matches").select("name").eq("api_id", matchId).maybeSingle();

  const at = new Date().toISOString();
  const res = await recordWrite(
    {
      env, source: "Gameday Ops · cut short", actorName: a.w.email, actorEmail: a.w.email, saveId: randomUUID(),
      matchId, matchName: (m.data?.name as string | undefined) ?? null,
      method: "POST", path: `/clubhouse/matches/${matchId}/cut-short`,
      body: { reason, minutes_played: minutes, note }, keys: [], label: (k) => k,
      applied: (_b, after) => after.reason === reason && after.minutes_played === minutes,
      changes: [{ key: "cut_short", field: "Cut short", before: "", after: `${CUT_SHORT_LABEL[reason]}, ${minutes} min played${note ? `: ${note}` : ""}` }],
    },
    {
      readResource: async () => (await readMark(a.w.supabase, env, matchId)) as Record<string, unknown>,
      write: async () => {
        const r = await a.w.supabase.from("match_cut_short").upsert({ env, match_id: matchId, reason, minutes_played: minutes, note, set_by_app_user_id: a.w.appUserId, set_by_email: a.w.email, created_at: at }, { onConflict: "env,match_id" });
        if (r.error) throw new Error(r.error.message);
      },
      now: () => at,
    },
    supabaseLogStore(),
  );
  if (res.error) return Response.json({ error: `The mark didn't save: ${res.error.message}`, outcome: res.outcome }, { status: 500 });
  return Response.json({ ok: true, outcome: res.outcome, logged: res.logged, mark: { match_id: matchId, reason, minutes_played: minutes, note } });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const a = await who(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  if (!a.w.canWrite) return Response.json({ error: "Removing a cut-short mark needs EDIT MATCHES." }, { status: 403 });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: "unknown environment" }, { status: 400 });
  const matchId = Number(new URL(req.url).searchParams.get("match_id"));
  if (!Number.isInteger(matchId) || matchId <= 0) return Response.json({ error: "match_id required" }, { status: 400 });
  const scope = await assertMatchInScope(a.w.supabase, a.w.scopeCity, matchId, env);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  const at = new Date().toISOString();
  const res = await recordWrite(
    {
      env, source: "Gameday Ops · cut short", actorName: a.w.email, actorEmail: a.w.email, saveId: randomUUID(), matchId, matchName: null,
      method: "DELETE", path: `/clubhouse/matches/${matchId}/cut-short`, body: {}, keys: [], label: (k) => k,
      applied: (_b, after) => after.reason == null,
      changes: [{ key: "cut_short", field: "Cut short", before: "marked", after: "removed" }],
    },
    {
      readResource: async () => (await readMark(a.w.supabase, env, matchId)) as Record<string, unknown>,
      write: async () => {
        const r = await a.w.supabase.from("match_cut_short").delete().eq("env", env).eq("match_id", matchId);
        if (r.error) throw new Error(r.error.message);
      },
      now: () => at,
    },
    supabaseLogStore(),
  );
  if (res.error) return Response.json({ error: "The mark wasn't removed." }, { status: 500 });
  return Response.json({ ok: true, outcome: res.outcome });
}
