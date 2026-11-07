// POST /api/admin/users/all-tabs-preset { userId } — Admin → User access's "All tabs" preset (Ryan,
// 2026-11-07): every staff app tab across all cities plus Edit matches and Send messages, in ONE
// update that only turns flags ON (src/lib/allTabsPreset.ts). Admin only; never a service account,
// a city manager or a city-confined account; logged through recordWrite into change_log with the
// target by id only; the verdict is a re-read.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { mapAppUsersConstraint } from "@/lib/appUsersConstraint";
import { ALL_TABS_PRESET_ON, allTabsPresetRefusal, holdsAllTabsPreset } from "@/lib/allTabsPreset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEYS = [...ALL_TABS_PRESET_ON] as string[];
const SELECT = ["id", "is_admin", "is_service_account", "is_city_manager", "city_identifier", ...KEYS].join(", ");
type Row = Record<string, unknown>;

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!userId) return Response.json({ error: "userId required" }, { status: 400 });

  const read = async (): Promise<Row> => {
    const r = await auth.supabase.from("app_users").select(SELECT).eq("id", userId).maybeSingle();
    return (r.data as Row | null) ?? {};
  };
  const t = await read();
  if (!t.id) return Response.json({ error: "No such user", outcome: "NOT APPLIED" }, { status: 404 });
  const refusal = allTabsPresetRefusal(t);
  if (refusal) return Response.json({ error: refusal, outcome: "NOT APPLIED" }, { status: 409 });
  if (holdsAllTabsPreset(t)) return Response.json({ ok: true, outcome: "NOT APPLIED", reason: "already set", user: t });

  // ONLY THE MISSING ONES: the update names nothing the person already holds, and turns nothing off.
  const next: Row = {};
  for (const k of KEYS) if (t[k] !== true) next[k] = true;
  const changes: Change[] = Object.keys(next).map((k) => ({ key: k, field: k, before: false, after: true }));

  let mapped: ReturnType<typeof mapAppUsersConstraint> = null;
  const { outcome, logged, error } = await recordWrite(
    {
      env: "production", source: "Admin · User access · All tabs preset",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "PATCH", path: `/app_users/${userId}`,
      body: next, keys: Object.keys(next), label: (k) => k,
      applied: (_b, a) => holdsAllTabsPreset(a),
      changes,
    },
    {
      readResource: read,
      write: async () => {
        const u = await auth.supabase.from("app_users").update(next).eq("id", userId).select("id");
        if (u.error) { mapped = mapAppUsersConstraint(u.error, next); throw new Error(u.error.message); }
        if (!u.data || u.data.length === 0) throw new Error("The update matched no rows — nothing was changed.");
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (mapped) {
    const m = mapped as { error: string; conflict: string; status: number };
    return Response.json({ ok: false, outcome: "FAILED", conflict: m.conflict, error: m.error }, { status: m.status });
  }
  const after = await read();
  const ok = holdsAllTabsPreset(after);
  return Response.json({ ok, outcome: ok ? "LANDED" : outcome.toUpperCase(), logRecorded: logged, error: ok ? undefined : error?.message ?? "The preset was not applied.", user: after }, { status: ok ? 200 : 502 });
}
