// GET/POST /api/admin/push-switches: the admin kill switch per staff app push event (Ryan,
// 2026-10-30). Off stops that event for everyone at once. Admins only; every change is recorded in
// change_log the same way a permission change is.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENTS = ["player_chat", "match_at_risk"] as const;
const LABEL: Record<string, string> = { player_chat: "Player chat pushes", match_at_risk: "Match at risk pushes" };

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const r = await auth.supabase.from("app_push_switches").select("event, enabled, updated_by, updated_at");
  if (r.error) return Response.json({ error: r.error.message }, { status: 500 });
  return Response.json({ switches: EVENTS.map((e) => r.data.find((x) => x.event === e) ?? { event: e, enabled: true, updated_by: null, updated_at: null }) });
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { event?: unknown; enabled?: unknown } | null;
  const event = typeof body?.event === "string" ? body.event : "";
  if (!(EVENTS as readonly string[]).includes(event) || typeof body?.enabled !== "boolean") {
    return Response.json({ error: "event (player_chat | match_at_risk) and enabled (true | false) are required" }, { status: 400 });
  }
  const enabled = body.enabled;
  const sb = auth.supabase;
  const readRow = async () => {
    const { data } = await sb.from("app_push_switches").select("enabled").eq("event", event).maybeSingle();
    return { enabled: data?.enabled ?? true };
  };
  const before = await readRow();
  if (before.enabled === enabled) return Response.json({ ok: true, outcome: "NOT APPLIED", reason: "already set", event, enabled });
  const { error, outcome } = await recordWrite(
    {
      env: "production", source: "Admin · staff app push",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "POST", path: "/api/admin/push-switches",
      body: { event, enabled },
      keys: ["enabled"],
      label: () => LABEL[event],
      applied: (_b, a) => a.enabled === enabled,
      changes: [{ key: "enabled", field: LABEL[event], before: before.enabled ? "on" : "off", after: enabled ? "on" : "off" }],
    },
    {
      readResource: readRow,
      write: async () => {
        const { error: e } = await sb.from("app_push_switches").upsert({ event, enabled, updated_by: auth.email, updated_at: new Date().toISOString() }, { onConflict: "event" });
        if (e) throw new Error(e.message);
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (error) return Response.json({ error: error.message, outcome }, { status: 500 });
  return Response.json({ ok: true, outcome, event, enabled });
}
