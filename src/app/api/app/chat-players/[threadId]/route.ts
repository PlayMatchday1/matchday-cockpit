// Staff app: WHO IS THIS CHAT THREAD'S PLAYER (Ryan, 2026-10-31). Read only.
//
// The thread's own linked player id (crm_threads.player_id), the one the desktop chat header and
// context pane use. When the thread is flagged match_ambiguous (the desktop's "this number is on
// more than one account"), every account on that number is listed too, from the same mdapi_users
// phone match the desktop context route counts with (countHistoricalAccounts), so the app can ask
// which player rather than guess. The profile itself is then read live by id through Player Lookup.
//
// Gated exactly as the desktop chat context: authenticateCrm, then the thread's city boundary.

import { authenticateCrm } from "@/lib/crmAuth";
import { assertThreadInScope } from "@/lib/crmScope";
import { toNationalDigits } from "@/lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

export async function GET(req: Request, ctx: { params: Promise<{ threadId: string }> }) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { threadId } = await ctx.params;
  const scope = await assertThreadInScope(auth, threadId);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });

  const t = await auth.supabase.from("crm_threads").select("id, phone_number, player_id, match_ambiguous").eq("id", threadId).maybeSingle();
  if (t.error) return Response.json({ error: t.error.message }, { status: 500 });
  if (!t.data) return Response.json({ error: "Thread not found" }, { status: 404 });
  const linked = (t.data.player_id as number | null) ?? null;
  const ambiguous = t.data.match_ambiguous === true;

  const ids = new Set<number>(linked != null ? [linked] : []);
  if (ambiguous) {
    const e164 = String(t.data.phone_number ?? "");
    const national = toNationalDigits(e164);
    for (const phone of [e164, national].filter(Boolean) as string[]) {
      const r = await auth.supabase.from("mdapi_users").select("id").eq("phone_number", phone).limit(20);
      for (const u of (r.data ?? []) as Row[]) ids.add(Number(u.id));
    }
  }
  const players: { id: number; name: string; city: string | null; joined: string | null; linked: boolean }[] = [];
  if (ids.size) {
    const r = await auth.supabase.from("mdapi_users").select("id, first_name, last_name, preferable_city_name, created_at").in("id", [...ids]);
    for (const u of (r.data ?? []) as Row[]) {
      players.push({
        id: Number(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || `Player ${u.id}`,
        city: (u.preferable_city_name as string | null) ?? null, joined: (u.created_at as string | null) ?? null, linked: Number(u.id) === linked,
      });
    }
    // Linked first, then newest account first (the desktop attaches the newest).
    players.sort((a, b) => Number(b.linked) - Number(a.linked) || String(b.joined).localeCompare(String(a.joined)));
  }
  return Response.json({ threadId, linkedPlayerId: linked, ambiguous, players });
}
