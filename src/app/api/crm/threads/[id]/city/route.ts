// PATCH /api/crm/threads/[id]/city — a person sets the thread's city from the thread header.
//
// Body: { city_code: "ATX" | "HOU" | ... }   (a CITY_SCOPES identifier)
//
// The city decides who sees the thread (src/lib/crmScope.ts) and who is pushed when it needs a human.
// A staff choice is final: drafts, links and the webhooks never overwrite city_source 'staff'.
//
// Auth: authenticateCrm, then the thread's own city boundary. A confined account may move one of its
// own threads to another city (a misrouted thread is handed off; it then leaves their view). Logged
// through recordWrite: read, write, read back; LANDED only when the read-back shows the new city.

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import { assertThreadInScope } from "@/lib/crmScope";
import { resolveCityScope } from "@/lib/cityScope";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  if (!auth.appUserId) return Response.json({ error: "Operator session required" }, { status: 403 });
  const { id: threadId } = await ctx.params;
  {
    const scope = await assertThreadInScope(auth, threadId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  const body = (await req.json().catch(() => ({}))) as { city_code?: unknown };
  const city = resolveCityScope(typeof body.city_code === "string" ? body.city_code.trim() : "")?.identifier ?? null;
  if (!city) return Response.json({ error: "Pick one of our cities." }, { status: 400 });

  const read = async () => {
    const r = await supabase.from("crm_threads").select("city_code, city_source").eq("id", threadId).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return (r.data ?? {}) as { city_code?: string | null; city_source?: string | null };
  };
  let before: { city_code?: string | null; city_source?: string | null };
  try { before = await read(); } catch { return Response.json({ error: "The thread couldn't be read." }, { status: 500 }); }
  if (before.city_code === city && before.city_source === "staff") return Response.json({ ok: true, outcome: "landed", city_code: city, unchanged: true });

  const at = new Date().toISOString();
  const res = await recordWrite(
    {
      env: "production", source: "crm-thread-city", actorName: auth.email ?? auth.appUserId, actorEmail: auth.email ?? null,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "PATCH", path: `/api/crm/threads/${threadId}/city`,
      body: { thread_id: threadId, from: before.city_code ?? null, to: city }, keys: [], label: (k) => k,
      applied: (_b, after) => after.city_code === city && after.city_source === "staff",
      changes: [{ key: "city_code", field: "Thread city", before: before.city_code ? `${before.city_code} (${before.city_source})` : "none", after: `${city} (staff)` }],
    },
    {
      readResource: async () => (await read()) as Record<string, unknown>,
      write: async () => {
        const r = await supabase.from("crm_threads").update({ city_code: city, city_source: "staff" }).eq("id", threadId);
        if (r.error) throw new Error(r.error.message);
      },
      now: () => at,
    },
    supabaseLogStore(),
  );
  if (res.error) return Response.json({ error: "The city didn't save." }, { status: 500 });
  return Response.json({ ok: true, outcome: res.outcome, logged: res.logged, city_code: city });
}
