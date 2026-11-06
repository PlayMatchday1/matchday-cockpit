// POST /api/admin/users/city-manager-preset { userId } — Admin → User access's "City manager" preset
// (Ryan, 2026-11-06). Sets the staff app's city grants on one city manager in ONE update: the
// CITY_MANAGER_PRESET_ON flags true and the CITY_MANAGER_PRESET_OFF flags false
// (src/lib/cityManagerPreset.ts). Every grant is confined to their city by the server.
//
// RULES, here and not only in the button:
//   - admin only (authenticateAdmin), service role;
//   - the account must already be a City Manager with a known city (set with the City Manager
//     control first): the preset grants WHAT, the city decides WHERE;
//   - never an admin or a service account;
//   - logged through recordWrite into change_log, the target by id only; the verdict is a re-read.
// Until migration 0256 is applied the database refuses it (app_users_city_manager_is_exclusive) and
// this answers 409 naming the migration.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { isCityManagerConstraintViolation } from "@/lib/appUsersConstraint";
import { resolveCityScope } from "@/lib/cityScope";
import { CITY_MANAGER_PRESET_OFF, CITY_MANAGER_PRESET_ON, holdsCityManagerPreset } from "@/lib/cityManagerPreset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEYS = [...CITY_MANAGER_PRESET_ON, ...CITY_MANAGER_PRESET_OFF] as string[];
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
  if (t.is_service_account === true) return Response.json({ error: "Service accounts hold no permissions.", outcome: "NOT APPLIED" }, { status: 403 });
  if (t.is_admin === true) return Response.json({ error: "This account is an Admin. The City manager preset is for City Manager accounts only.", outcome: "NOT APPLIED" }, { status: 409 });
  if (t.is_city_manager !== true || !resolveCityScope(String(t.city_identifier ?? ""))) {
    return Response.json({ error: "Make this account a City Manager with a city first; the preset's grants are confined to that city.", outcome: "NOT APPLIED" }, { status: 409 });
  }
  if (holdsCityManagerPreset(t)) return Response.json({ ok: true, outcome: "NOT APPLIED", reason: "already set" });

  const next: Row = {};
  for (const k of CITY_MANAGER_PRESET_ON) next[k] = true;
  for (const k of CITY_MANAGER_PRESET_OFF) next[k] = false;
  const changes: Change[] = KEYS.filter((k) => (t[k] === true) !== next[k]).map((k) => ({ key: k, field: k, before: t[k] === true, after: next[k] }));

  let constraint = false;
  const { outcome, logged, error } = await recordWrite(
    {
      env: "production", source: "Admin · User access · City manager preset",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "PATCH", path: `/app_users/${userId}`,
      body: next, keys: KEYS, label: (k) => k,
      applied: (_b, a) => holdsCityManagerPreset({ ...a, is_city_manager: true }),
      changes,
    },
    {
      readResource: read,
      write: async () => {
        const u = await auth.supabase.from("app_users").update(next).eq("id", userId).select("id");
        if (u.error) { constraint = isCityManagerConstraintViolation(u.error); throw new Error(u.error.message); }
        if (!u.data || u.data.length === 0) throw new Error("The update matched no rows — nothing was changed.");
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (constraint) {
    return Response.json({
      ok: false, outcome: "FAILED", conflict: "city-manager-exclusive",
      error: "The database still refuses a City Manager holding Match Ops, Chats, Player Lifecycle or Growth. Apply migration 0256 (supabase/migrations/0256_city_manager_staff_app.sql) first.",
    }, { status: 409 });
  }
  const after = await read();
  const ok = holdsCityManagerPreset({ ...after, is_city_manager: true });
  return Response.json({ ok, outcome: ok ? "LANDED" : outcome.toUpperCase(), logRecorded: logged, error: ok ? undefined : error?.message ?? "The preset was not applied.", user: after }, { status: ok ? 200 : 502 });
}
