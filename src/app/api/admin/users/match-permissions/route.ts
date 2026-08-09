// Phase 17 — the grant path for MATCH OPS (read) and EDIT MATCHES (write). Admin-gated,
// service-role. The hard rules live here (and are backed by DB constraints/triggers so a
// direct client write can't skirt them):
//   rule 2  EDIT MATCHES requires MATCH OPS; revoking MATCH OPS revokes EDIT MATCHES,
//           atomically, in one update.
//   rule 3  the Clubhouse E2E service account can never hold EDIT MATCHES.
//   rule 4  a user cannot revoke their OWN EDIT MATCHES / MATCH OPS if it would leave
//           ZERO users holding EDIT MATCHES.
// This route NEVER touches Vercel env or MatchDay — it only sets app_users flags.

import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { userId?: string; canAccessMatchops?: boolean; canEditMatches?: boolean } | null;
  if (!body?.userId) return Response.json({ error: "userId required" }, { status: 400 });

  const cur = await auth.supabase
    .from("app_users")
    .select("id, email, full_name, is_service_account, can_access_matchops, can_edit_matches")
    .eq("id", body.userId)
    .maybeSingle();
  if (cur.error || !cur.data) return Response.json({ error: "user not found" }, { status: 404 });
  const t = cur.data as { id: string; email: string; is_service_account: boolean; can_access_matchops: boolean; can_edit_matches: boolean };

  // Desired next state (fall back to current when a flag is omitted).
  let nextMatchops = body.canAccessMatchops ?? t.can_access_matchops;
  let nextEdit = body.canEditMatches ?? t.can_edit_matches;
  // rule 2 cascade — no read means no write, applied in the same update.
  if (!nextMatchops) nextEdit = false;

  // rule 2 grant — cannot grant EDIT MATCHES without MATCH OPS.
  if (nextEdit && !nextMatchops) return Response.json({ error: "EDIT MATCHES requires MATCH OPS." }, { status: 400 });
  // rule 3 — the E2E service account can never hold EDIT MATCHES.
  if (nextEdit && t.is_service_account) {
    return Response.json({ error: "The Clubhouse E2E service account cannot hold EDIT MATCHES — it exists to run read-only smoke tests." }, { status: 403 });
  }
  // rule 4 — self-demotion may not empty the EDIT MATCHES holder set.
  const losingEdit = t.can_edit_matches && !nextEdit;
  if (losingEdit && body.userId === auth.appUserId) {
    const holders = await auth.supabase.from("app_users").select("id").eq("can_edit_matches", true).neq("id", body.userId);
    const others = (holders.data ?? []).length;
    if (others === 0) {
      return Response.json({ error: "Refusing: you are the last user holding EDIT MATCHES. Grant it to someone else before removing your own." }, { status: 409 });
    }
  }

  const upd = await auth.supabase
    .from("app_users")
    .update({ can_access_matchops: nextMatchops, can_edit_matches: nextEdit })
    .eq("id", body.userId)
    .select("id, can_access_matchops, can_edit_matches")
    .maybeSingle();
  if (upd.error) return Response.json({ error: upd.error.message }, { status: 400 });
  return Response.json({ ok: true, user: upd.data });
}
