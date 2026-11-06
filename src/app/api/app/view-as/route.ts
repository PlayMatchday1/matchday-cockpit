// /api/app/view-as: the staff app's admin-only "View as" (Ryan, 2026-11-06). See src/lib/viewAs.ts
// for how a View as is honoured; this route only starts, stops and lists.
//
//   GET                           the Clubhouse users an admin can view as (the Me screen's picker)
//   POST   { targetId, env }      start: logs it in change_log, answers { token, viewing }
//   DELETE { reason, env }        stop, with the token in X-Clubhouse-View-As: logs it in change_log
//
// Every call is checked on the REAL signed-in row (resolveSessionUser with ignoreViewAs): an
// unconfined admin, or a 403. A non-admin is refused here and at every other route that sees the
// header.

import { randomUUID } from "node:crypto";
import { resolveSessionUser } from "@/lib/adminAuth";
import { type SupabaseClient } from "@supabase/supabase-js";
import { confinedCity } from "@/lib/cityConfinement";
import { cityNameFor } from "@/lib/cityScope";
import { appAccess } from "@/lib/appModel";
import { reviewMasked } from "@/lib/reviewAccount";
import { canViewAs, claimsForStop, issueViewAs, VIEW_AS_ADMINS_ONLY, VIEW_AS_HEADER, VIEW_AS_INVALID } from "@/lib/viewAs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "Staff app · View as";
type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const nameOf = (r: Row) => str(r.full_name) ?? str(r.email) ?? String(r.id);
const ROLE: Record<string, string> = { operator: "Operations", confined: "Operations, one city", city_manager: "City manager", none: "No Match Ops access" };

/** "Garrett Suits (Austin)"; an unconfined account has no city in brackets. */
function labelOf(r: Row): { name: string; city: string | null; label: string } {
  const raw = str(r.city_identifier);
  const city = raw ? cityNameFor(confinedCity(r)) ?? raw : null;
  const name = nameOf(r);
  return { name, city, label: city ? `${name} (${city})` : name };
}

function describe(r: Row) {
  const l = labelOf(r);
  const a = appAccess(r, confinedCity(r));
  return {
    id: String(r.id), name: l.name, email: str(r.email), city: l.city, label: l.label,
    role: r.is_admin === true ? "Admin" : ROLE[a.tier], tier: a.tier,
  };
}

async function realAdmin(req: Request) {
  const r = await resolveSessionUser(req, { ignoreViewAs: true });
  if (!r.ok) return r;
  if (!canViewAs(r.row)) return { ok: false as const, status: 403, error: VIEW_AS_ADMINS_ONLY };
  return r;
}

const envOf = (v: unknown) => (v === "staging" ? "staging" : "production");

async function getRoute(req: Request) {
  const a = await realAdmin(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  const q = await a.supabase.from("app_users").select("*");
  if (q.error) return Response.json({ error: q.error.message }, { status: 500 });
  const users = (q.data as Row[])
    .filter((r) => r.is_service_account !== true && String(r.id) !== String(a.row.id) && str(r.email))
    .map(describe)
    .sort((x, y) => x.name.localeCompare(y.name));
  return Response.json({ users }, { headers: { "Cache-Control": "no-store" } });
}

// The review account is never an admin, so this answers it 403; wrapped like every app GET.
export const GET = reviewMasked(getRoute);

export async function POST(req: Request) {
  const a = await realAdmin(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  // Starting one while another is on would hide the first one's stop. Exit first.
  if (req.headers.get(VIEW_AS_HEADER)) return Response.json({ error: "Exit the current View as first." }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { targetId?: unknown; env?: unknown } | null;
  const targetId = str(body?.targetId);
  if (!targetId) return Response.json({ error: "targetId is required" }, { status: 400 });
  if (targetId === String(a.row.id)) return Response.json({ error: "That is your own account." }, { status: 400 });
  const t = await a.supabase.from("app_users").select("*").eq("id", targetId).maybeSingle();
  if (t.error) return Response.json({ error: t.error.message }, { status: 500 });
  if (!t.data || t.data.is_service_account === true || !str(t.data.email)) return Response.json({ error: "No such Clubhouse user." }, { status: 404 });
  const now = Date.now();
  const token = issueViewAs(String(a.row.id), targetId, now);
  if (!token) return Response.json({ error: "View as is not configured on the server." }, { status: 500 });
  const viewing = describe(t.data as Row);
  // The start is logged BEFORE the token is handed over: a View as that is not in change_log
  // does not start.
  try {
    await logViewAs(a, "POST", envOf(body?.env), { viewAs: viewing.label, targetId }, [
      { key: "viewAs", field: "View as", before: null, after: `${viewing.label} · ${viewing.role}` },
    ], now);
  } catch (e) {
    return Response.json({ error: `View as was not started: change_log refused it (${e instanceof Error ? e.message : String(e)}).` }, { status: 500 });
  }
  return Response.json({ token, viewing, startedAt: new Date(now).toISOString() });
}

export async function DELETE(req: Request) {
  const a = await realAdmin(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  const token = req.headers.get(VIEW_AS_HEADER)?.trim() ?? "";
  const c = token ? claimsForStop(token, String(a.row.id)) : null;
  if (!c) return Response.json({ error: VIEW_AS_INVALID }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown; env?: unknown } | null;
  const reason = body?.reason === "relaunch" ? "relaunch" : body?.reason === "expired" ? "expired" : "exit";
  const t = await a.supabase.from("app_users").select("*").eq("id", c.t).maybeSingle();
  const label = t.data ? labelOf(t.data as Row).label : c.t;
  const now = Date.now();
  const minutes = Math.max(0, Math.round((now - c.s) / 60_000));
  try {
    await logViewAs(a, "DELETE", envOf(body?.env), { viewAs: label, targetId: c.t, reason, startedAt: new Date(c.s).toISOString() }, [
      { key: "viewAs", field: "View as", before: label, after: `ended (${reason === "exit" ? "Exit" : reason === "relaunch" ? "app relaunched" : "4 hours up"}) after ${minutes} min` },
    ], now);
  } catch (e) {
    return Response.json({ error: `The stop was not logged: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  return Response.json({ stopped: true, viewAs: label, minutes });
}

async function logViewAs(
  a: { row: Row; email: string; supabase: SupabaseClient }, method: string, env: string, body: Record<string, unknown>,
  changes: { key: string; field: string; before: unknown; after: unknown }[], now: number,
) {
  // A direct insert (not recordWrite: there is no MatchDay write to read back, and the shared store
  // drops insert errors). An error is thrown so the caller refuses rather than run an unlogged View as.
  const w = await a.supabase.from("change_log").insert({
    save_id: randomUUID(), created_at: new Date(now).toISOString(), actor_name: nameOf(a.row), actor_email: a.email,
    source: SOURCE, env, match_id: null, match_name: null, method, endpoint: "/api/app/view-as",
    request_body: body, outcome: "landed", server_said: null, changes,
  });
  if (w.error) throw new Error(w.error.message);
}
