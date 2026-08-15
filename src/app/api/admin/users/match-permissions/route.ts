// Phase 17 — the grant path for MATCH OPS (read) and EDIT MATCHES (write). Admin-gated,
// service-role. The hard rules live here (and are backed by DB constraints/triggers so a
// direct client write can't skirt them):
//   rule 2  EDIT MATCHES requires MATCH OPS; revoking MATCH OPS revokes EDIT MATCHES,
//           atomically, in one update.
//   rule 3  the Clubhouse E2E service account can never hold EDIT MATCHES.
//   rule 4  a user cannot revoke their OWN EDIT MATCHES / MATCH OPS if it would leave
//           ZERO users holding EDIT MATCHES.
// This route NEVER touches Vercel env or MatchDay — it only sets app_users flags.

import { mapAppUsersConstraint } from "@/lib/appUsersConstraint";
import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { userId?: string; canAccessMatchops?: boolean; canEditMatches?: boolean; canManagePlayers?: boolean } | null;
  if (!body?.userId) return Response.json({ error: "userId required" }, { status: 400 });

  const cur = await auth.supabase
    .from("app_users")
    .select("id, email, full_name, is_service_account, can_access_matchops, can_edit_matches, can_manage_players")
    .eq("id", body.userId)
    .maybeSingle();
  if (cur.error || !cur.data) return Response.json({ error: "user not found" }, { status: 404 });
  const t = cur.data as { id: string; email: string; is_service_account: boolean; can_access_matchops: boolean; can_edit_matches: boolean; can_manage_players: boolean };

  // Desired next state (fall back to current when a flag is omitted).
  const nextMatchops = body.canAccessMatchops ?? t.can_access_matchops;
  let nextEdit = body.canEditMatches ?? t.can_edit_matches;
  let nextManage = body.canManagePlayers ?? t.can_manage_players;
  // rule 2 cascade — no read means no write (edit AND manage), applied in the same update.
  if (!nextMatchops) { nextEdit = false; nextManage = false; }

  // rule 2 grant — a write permission requires MATCH OPS.
  if (nextEdit && !nextMatchops) return Response.json({ error: "EDIT MATCHES requires MATCH OPS." }, { status: 400 });
  if (nextManage && !nextMatchops) return Response.json({ error: "MANAGE PLAYERS requires MATCH OPS." }, { status: 400 });
  // rule 3 — the E2E service account can never hold a write permission.
  if (nextEdit && t.is_service_account) {
    return Response.json({ error: "The Clubhouse E2E service account cannot hold EDIT MATCHES — it exists to run read-only smoke tests." }, { status: 403 });
  }
  if (nextManage && t.is_service_account) {
    return Response.json({ error: "The Clubhouse E2E service account cannot hold MANAGE PLAYERS — it exists to run read-only smoke tests." }, { status: 403 });
  }
  // rule 4 — self-demotion may not empty a write-permission holder set.
  const losingEdit = t.can_edit_matches && !nextEdit;
  if (losingEdit && body.userId === auth.appUserId) {
    const holders = await auth.supabase.from("app_users").select("id").eq("can_edit_matches", true).neq("id", body.userId);
    if ((holders.data ?? []).length === 0) {
      return Response.json({ error: "Refusing: you are the last user holding EDIT MATCHES. Grant it to someone else before removing your own." }, { status: 409 });
    }
  }
  const losingManage = t.can_manage_players && !nextManage;
  if (losingManage && body.userId === auth.appUserId) {
    const holders = await auth.supabase.from("app_users").select("id").eq("can_manage_players", true).neq("id", body.userId);
    if ((holders.data ?? []).length === 0) {
      return Response.json({ error: "Refusing: you are the last user holding MANAGE PLAYERS. Grant it to someone else before removing your own." }, { status: 409 });
    }
  }

  const upd = await auth.supabase
    .from("app_users")
    .update({ can_access_matchops: nextMatchops, can_edit_matches: nextEdit, can_manage_players: nextManage })
    .eq("id", body.userId)
    .select("id, can_access_matchops, can_edit_matches, can_manage_players, is_service_account")
    .maybeSingle();
  // The DB triggers (0114/0116) raise P0001 on a service account or a write-without-matchops
  // attempt — surface the message verbatim, do not swallow it.
  // Migration 0124's CHECK is different: it would arrive as a raw Postgres string naming the
  // constraint. Ticking Match Ops on a city manager is a REAL thing an admin will try from this
  // grid, so it reads as a stated refusal instead (409), matching the grant route's wording.
  if (upd.error) {
    const mapped = mapAppUsersConstraint(upd.error, { can_access_matchops: nextMatchops });
    if (mapped) return Response.json({ error: mapped.error, conflict: mapped.conflict }, { status: mapped.status });
    return Response.json({ error: upd.error.message, code: upd.error.code }, { status: 400 });
  }
  // Re-read the row after the write so the client renders ACTUAL DB state (the trigger
  // may have cascaded, e.g. matchops off => edit/manage off), never the optimistic guess.
  const fresh = await auth.supabase
    .from("app_users")
    .select("id, can_access_matchops, can_edit_matches, can_manage_players, is_service_account")
    .eq("id", body.userId)
    .maybeSingle();
  return Response.json({ ok: true, user: fresh.data ?? upd.data });
}
