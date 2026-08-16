// DELETE AN ADMIN ACCOUNT — server-side, admin-gated, logged, verdict by re-read.
//
// WHAT THIS REPLACES. AdminUsersView deleted straight from the browser:
//
//     setUsers((prev) => prev.filter((u) => u.id !== user.id));   // optimistic, BEFORE the await
//     const { error } = await supabase.from("app_users").delete().eq("id", user.id);
//     if (error) { setUsers(original); alert(error.message); }
//
// RLS on app_users grants SELECT to authenticated callers and nothing else. A DELETE therefore
// matches ZERO rows and PostgREST answers 204 with `error: null` — indistinguishable from success.
// The code checked only `error`, so the rollback could never fire, and the row had already been
// removed from the list. Gone until refresh, back after. Measured, not inferred: the same call on
// a throwaway row returns 204 / error null / `.select()` → [] while the row remains.
//
// SO THE FIX IS NOT A BETTER CLIENT CALL. The client cannot write this table at all — by design,
// as far as the policy is concerned. It moves here, to the service-role client the admin gate
// already establishes, which is the same shape as the partner payment writes.
//
// A DELETE THAT LEAVES THE AUTH IDENTITY IS NOT A DELETE. Removing the app_users row alone leaves
// the person able to authenticate; they land without a profile rather than being locked out. Both
// go, and the Auth user is looked up BY EMAIL because app_users.id and the Auth uid are different
// values (verified on a real account).
//
// ONE ATTEMPT. Nothing retries. The verdict comes from reading BOTH stores back afterwards, never
// from a status code — that is precisely what fooled the old code.
//
// THE LOG CARRIES THE EMAIL AND NOTHING ELSE. An account deletion is worth recording; the rest of
// the row (name, phone, permissions) is PII with different access rules and is not written here.
import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthUserLite = { id: string; email?: string };

async function findAuthUserByEmail(
  admin: { listUsers: (p: { page: number; perPage: number }) => Promise<{ data: { users: AuthUserLite[] } | null }> },
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase();
  // Paged rather than a single big fetch: listUsers caps perPage, and a silent truncation here
  // would report "no auth user" for somebody who has one — which is the failure this route exists
  // to stop, in a new costume.
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (users.length < 200) break;
  }
  return null;
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const { data: target } = await supabase.from("app_users").select("id, email").eq("id", id).maybeSingle();
  if (!target) return Response.json({ error: "No such user", outcome: "NOT APPLIED" }, { status: 404 });

  const email = String(target.email ?? "");
  // YOU CANNOT DELETE YOURSELF. The client already refuses, but a hand-made request must not be
  // able to lock the last admin out of the tool that grants admin.
  if (email.toLowerCase() === auth.email.toLowerCase()) {
    return Response.json({ error: "You cannot delete your own account.", outcome: "NOT APPLIED" }, { status: 400 });
  }

  const authUserId = await findAuthUserByEmail(supabase.auth.admin, email);

  // BOTH STORES, read before and after. `applied` is what decides the outcome.
  const readBoth = async (): Promise<Record<string, unknown>> => {
    const { data: row } = await supabase.from("app_users").select("id").eq("id", id).maybeSingle();
    const stillAuth = authUserId ? await findAuthUserByEmail(supabase.auth.admin, email) : null;
    return { appUser: row ? "present" : "absent", authUser: stillAuth ? "present" : "absent" };
  };

  const changes: Change[] = [
    { key: "account", field: "Account", before: email, after: "deleted" },
    { key: "authUser", field: "Sign-in identity", before: authUserId ? "present" : "none", after: "deleted" },
  ];

  const { error: writeErr, outcome } = await recordWrite(
    {
      env: "production", source: "User admin · delete account",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "DELETE", path: `/admin/users/${id}`,
      // EMAIL ONLY. No name, no phone, no permission flags.
      body: { email },
      keys: ["appUser", "authUser"],
      label: (k) => (k === "appUser" ? "Profile row" : "Sign-in identity"),
      // THE VERDICT: both stores must be clear. An app_users row that vanished while the Auth user
      // survived is NOT a completed delete, and saying so is the whole point of this route.
      applied: (_b, a) => a.appUser === "absent" && a.authUser === "absent",
      changes,
    },
    {
      readResource: readBoth,
      write: async () => {
        // ONE ATTEMPT each, and the row count is READ, not assumed.
        const { data: deleted, error } = await supabase.from("app_users").delete().eq("id", id).select("id");
        if (error) throw new Error(error.message);
        if (!deleted || deleted.length === 0) {
          throw new Error("The profile row was not removed — the delete matched no rows.");
        }
        if (authUserId) {
          const { error: authErr } = await supabase.auth.admin.deleteUser(authUserId);
          // A profile removed but an identity left behind is a HALF delete, and the person can
          // still authenticate. Surface it rather than reporting success.
          if (authErr) throw new Error(`Profile removed, but the sign-in identity was not: ${authErr.message}`);
        }
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  const after = await readBoth();
  const OUT: Record<string, string> = { landed: "LANDED", failed: "FAILED", "not applied": "NOT APPLIED", unknown: "UNKNOWN" };
  const reported = OUT[outcome] ?? "UNKNOWN";
  const done = after.appUser === "absent" && after.authUser === "absent";

  if (!done) {
    return Response.json({
      ok: false, outcome: reported,
      error: writeErr?.message ?? "The account was not fully removed.",
      appUser: after.appUser, authUser: after.authUser,
    }, { status: 502 });
  }
  return Response.json({ ok: true, outcome: reported, appUser: after.appUser, authUser: after.authUser });
}
