// GET   /api/crm/auto-send/config — the one row, for anyone with chats access.
// PATCH /api/crm/auto-send/config — change it. Admins only.
//
// is_admin is read fresh from app_users on this request (authenticateCrm), nothing cached in a JWT. A
// service account and the cron secret are refused: a grey panel is a courtesy, this is the control.
// Every change goes into change_log. Turning auto-send off, or back to shadow, cancels every hold.

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { AUTO_ACTION_CATEGORIES, AUTO_CATEGORIES, isAutoSendLive, type AutoSendConfig } from "@/lib/aiDraftModel";
import { cancelAllHolds } from "@/lib/aiDraftAutoRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLS = "auto_categories, action_categories, credit_cap_cents, hold_minutes, enabled, shadow, disabled_reason, disabled_at, updated_at";
const MAX_CAP_CENTS = 20000;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const r = await auth.supabase.from("crm_auto_send_config").select(COLS).maybeSingle();
  if (r.error || !r.data) return Response.json({ error: "Couldn't read the auto-send settings." }, { status: 500 });
  return Response.json({ config: r.data, can_edit: auth.isAdmin && !!auth.appUserId, categories: AUTO_CATEGORIES, action_categories: AUTO_ACTION_CATEGORIES }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin || !auth.appUserId) return Response.json({ error: "Only an admin can change auto-send." }, { status: 403 });
  const { supabase } = auth;
  const me = await supabase.from("app_users").select("*").eq("id", auth.appUserId).maybeSingle();
  if (me.data?.is_service_account === true) return Response.json({ error: "A service account can't change auto-send." }, { status: 403 });

  const b = (await req.json().catch(() => null)) as Partial<AutoSendConfig> | null;
  if (!b) return Response.json({ error: "body required" }, { status: 400 });
  const patch: Partial<AutoSendConfig> = {};
  const list = (v: unknown, allowed: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string" && allowed.includes(x)) ? [...new Set(v as string[])] : null);
  if (b.auto_categories !== undefined) {
    const l = list(b.auto_categories, AUTO_CATEGORIES);
    if (!l) return Response.json({ error: "That category can't be turned on." }, { status: 400 });
    patch.auto_categories = l;
  }
  if (b.action_categories !== undefined) {
    const l = list(b.action_categories, AUTO_ACTION_CATEGORIES);
    if (!l) return Response.json({ error: "Actions can't be turned on for that category." }, { status: 400 });
    patch.action_categories = l;
  }
  if (b.credit_cap_cents !== undefined) {
    if (!Number.isInteger(b.credit_cap_cents) || b.credit_cap_cents < 0 || b.credit_cap_cents > MAX_CAP_CENTS) return Response.json({ error: "The credit cap must be $0 to $200." }, { status: 400 });
    patch.credit_cap_cents = b.credit_cap_cents;
  }
  if (b.hold_minutes !== undefined) {
    if (!Number.isInteger(b.hold_minutes) || b.hold_minutes < 1 || b.hold_minutes > 60) return Response.json({ error: "The hold must be 1 to 60 minutes." }, { status: 400 });
    patch.hold_minutes = b.hold_minutes;
  }
  for (const k of ["enabled", "shadow"] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== "boolean") return Response.json({ error: `${k} must be true or false.` }, { status: 400 });
      patch[k] = b[k];
    }
  }
  if (Object.keys(patch).length === 0) return Response.json({ error: "Nothing to change." }, { status: 400 });

  const read = async () => (await supabase.from("crm_auto_send_config").select(COLS).maybeSingle()).data as (AutoSendConfig & Record<string, unknown>) | null;
  const before = await read();
  if (!before) return Response.json({ error: "Couldn't read the auto-send settings." }, { status: 500 });
  const at = new Date().toISOString();
  const row = { ...patch, updated_at: at, updated_by_user_id: auth.appUserId, ...(patch.enabled === true ? { disabled_reason: null, disabled_at: null } : patch.enabled === false ? { disabled_reason: `Turned off by ${auth.email}.`, disabled_at: at } : {}) };
  const { error, outcome } = await recordWrite(
    {
      env: "production", source: "crm-auto-send", actorName: auth.email ?? auth.appUserId, actorEmail: auth.email, saveId: randomUUID(), matchId: null, matchName: null,
      method: "PATCH", path: "/api/crm/auto-send/config", body: patch as Record<string, unknown>, keys: [], label: (k) => k,
      applied: (_b, a) => Object.entries(patch).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v)),
      changes: Object.entries(patch).map(([k, v]) => ({ key: k, field: `Auto-send ${k}`, before: JSON.stringify(before[k]), after: JSON.stringify(v) })),
    },
    {
      readResource: async () => ((await read()) ?? {}) as Record<string, unknown>,
      write: async () => {
        const u = await supabase.from("crm_auto_send_config").update(row).eq("id", true);
        if (u.error) throw new Error(u.error.message);
        return u.data;
      },
      now: () => at,
    },
    supabaseLogStore(),
  );
  if (error) return Response.json({ error: "The settings didn't save." }, { status: 500 });
  const after = await read();
  if (after && !isAutoSendLive(after)) await cancelAllHolds(supabase, patch.enabled === false ? `Auto-send turned off by ${auth.email}.` : "Auto-send is off.").catch(() => {});
  return Response.json({ config: after, outcome });
}
