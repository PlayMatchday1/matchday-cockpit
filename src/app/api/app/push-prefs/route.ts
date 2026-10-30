// GET/POST /api/app/push-prefs: the signed-in staff member's own two switches from the avatar sheet
// (Ryan, 2026-10-30). No row means both on. Only ever this person's own row.

import { authenticateApp } from "@/lib/appAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEYS = ["player_chats", "matches_at_risk"] as const;

export async function GET(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const r = await auth.supabase.from("app_push_prefs").select("player_chats, matches_at_risk").eq("app_user_id", auth.appUserId).maybeSingle();
  if (r.error) return Response.json({ error: r.error.message }, { status: 500 });
  return Response.json({ playerChats: r.data?.player_chats ?? true, matchesAtRisk: r.data?.matches_at_risk ?? true });
}

export async function POST(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  if (!(KEYS as readonly string[]).includes(key) || typeof body?.value !== "boolean") {
    return Response.json({ error: "key (player_chats | matches_at_risk) and value (true | false) are required" }, { status: 400 });
  }
  const w = await auth.supabase.from("app_push_prefs").upsert({ app_user_id: auth.appUserId, [key]: body.value, updated_at: new Date().toISOString() }, { onConflict: "app_user_id" });
  if (w.error) return Response.json({ error: w.error.message }, { status: 500 });
  // Read back: the switch shows what is stored, not what was asked.
  const r = await auth.supabase.from("app_push_prefs").select("player_chats, matches_at_risk").eq("app_user_id", auth.appUserId).single();
  if (r.error) return Response.json({ error: r.error.message }, { status: 500 });
  return Response.json({ playerChats: r.data.player_chats, matchesAtRisk: r.data.matches_at_risk });
}
