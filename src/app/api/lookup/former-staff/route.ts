/* /api/lookup/former-staff — Player Lookup's "Former staff" switch (0266, 2026-11-09).
 *
 * GET ?playerId=N   the flag for that player's PERSON (growth_person_link: a deleted account's id resolves to the
 *                   live account it belongs to), with who set it and when.
 * POST { playerId, formerStaff: boolean, note? }   sets or clears it. MANAGE PLAYERS, read fresh per request by
 *                   authenticateMatchOpsRead. The row is read back; LANDED only when it says what was asked.
 *
 * A former-staff person is left off the Churn list (churnLoad.formerStaff). Clubhouse data only: no MatchDay call. */
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";

export const runtime = "nodejs";

type Row = Record<string, unknown>;

async function personOf(sb: import("@supabase/supabase-js").SupabaseClient, playerId: number): Promise<number> {
  const { data, error } = await sb.from("growth_person_link").select("person_id").eq("account_id", playerId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? Number((data as Row).person_id) : playerId;
}

async function read(sb: import("@supabase/supabase-js").SupabaseClient, personId: number) {
  const { data, error } = await sb.from("player_former_staff").select("former_staff, note, set_by, set_at").eq("person_id", personId).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data as Row | null;
  return { personId, formerStaff: r?.former_staff === true, note: (r?.note as string | null) ?? null, setBy: (r?.set_by as string | null) ?? null, setAt: (r?.set_at as string | null) ?? null };
}

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const playerId = Number(new URL(req.url).searchParams.get("playerId"));
  if (!Number.isInteger(playerId) || playerId <= 0) return Response.json({ error: "playerId required" }, { status: 400 });
  try {
    return Response.json({ ...(await read(auth.supabase, await personOf(auth.supabase, playerId))), canManage: auth.canManagePlayers });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePlayers) {
    console.warn(`[former-staff] 403: ${auth.email} tried to change the former-staff flag without MANAGE PLAYERS`);
    return Response.json({ error: "Setting former staff needs MANAGE PLAYERS." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { playerId?: unknown; formerStaff?: unknown; note?: unknown } | null;
  const playerId = Number(body?.playerId);
  if (!Number.isInteger(playerId) || playerId <= 0 || typeof body?.formerStaff !== "boolean") {
    return Response.json({ error: "Send { playerId, formerStaff: true | false }." }, { status: 400 });
  }
  const want = body.formerStaff;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  try {
    const personId = await personOf(auth.supabase, playerId);
    const { error } = await auth.supabase.from("player_former_staff").upsert(
      { person_id: personId, former_staff: want, note, set_by: auth.email.toLowerCase(), set_at: new Date().toISOString() },
      { onConflict: "person_id" },
    );
    if (error) return Response.json({ verdict: "FAILED", error: error.message }, { status: 500 });
    const after = await read(auth.supabase, personId);
    const verdict = after.formerStaff === want ? "LANDED" : "NOT APPLIED";
    return Response.json({ verdict, ...after }, { status: verdict === "LANDED" ? 200 : 502 });
  } catch (e) {
    return Response.json({ verdict: "UNKNOWN", error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
