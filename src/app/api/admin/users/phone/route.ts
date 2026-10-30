// Admin: SET OR CLEAR A STAFF MEMBER'S MOBILE NUMBER, for sign-in by text code in the staff app.
//
// Two stores, one write each, in this order:
//   1. app_users.phone, the number the Send SMS hook checks before it texts anyone (unique, E.164).
//   2. the staff member's EXISTING Supabase auth user (found by email), phone set and confirmed via
//      the admin API, so phone sign-in signs in that same user with the same app_users row. No auth
//      user is ever created here.
// If step 2 fails after step 1 landed, the route says so plainly: the hook would allow a code, but
// Supabase would not know the number, so sign-in by that number does not work until it is retried.
//
// Admin-gated, service role. The change_log entry carries the LAST FOUR DIGITS only, never the
// number (the standing rule for phones in change_log).

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore, phoneLast4 } from "@/lib/changeLog";
import { normalizePhone } from "@/lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { userId?: string; phone?: string | null } | null;
  if (!body?.userId) return Response.json({ error: "userId required" }, { status: 400 });
  const clearing = body.phone == null || String(body.phone).trim() === "";
  const phone = clearing ? null : normalizePhone(String(body.phone));
  if (!clearing && !phone) return Response.json({ error: "That is not a valid mobile number. Include the country code if it is not a US number." }, { status: 400 });

  const cur = await auth.supabase.from("app_users").select("id, email, phone").eq("id", body.userId).maybeSingle();
  if (cur.error) {
    const missing = /phone/.test(cur.error.message) && /(does not exist|column)/i.test(cur.error.message);
    return Response.json({ error: missing ? "The phone column has not been added to app_users yet." : cur.error.message }, { status: missing ? 503 : 500 });
  }
  if (!cur.data) return Response.json({ error: "user not found" }, { status: 404 });
  const email = String(cur.data.email).toLowerCase();

  const { outcome, error: writeError } = await recordWrite(
    {
      env: "production", source: "Admin · User access · Phone",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(), matchId: null, matchName: null,
      method: "PUT", path: `/app_users/${body.userId}`,
      body: { phone_last4: phone ? phoneLast4(phone) : null }, keys: ["phone_last4"], label: () => "Phone (last 4)",
      applied: (_b, a) => ((a.user as { phone?: string | null } | undefined)?.phone ?? null) === phone,
      changes: [{ key: "phone_last4", field: "Phone (last 4)", before: cur.data.phone ? phoneLast4(cur.data.phone) : null, after: phone ? phoneLast4(phone) : null }],
    },
    {
      readResource: async () => ({ user: (await auth.supabase.from("app_users").select("id, phone").eq("id", body.userId!).maybeSingle()).data ?? {} }),
      write: async () => {
        const upd = await auth.supabase.from("app_users").update({ phone }).eq("id", body.userId!).select("id, phone").maybeSingle();
        if (upd.error) {
          const dup = /app_users_phone_key|duplicate key/i.test(upd.error.message);
          throw new Error(dup ? "That number is already on another staff account." : upd.error.message);
        }
        return upd.data;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (outcome !== "landed") {
    return Response.json({ error: writeError?.message ?? (outcome === "failed" ? "The number was not saved." : `The save is ${outcome}; reload before trying again.`), outcome }, { status: 409 });
  }

  // Step 2: the existing auth user, found by email exactly as sign-in resolves it.
  let authUserId: string | null = null;
  for (let page = 1; page <= 10 && !authUserId; page++) {
    const { data, error } = await auth.supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    authUserId = data.users.find((u) => (u.email ?? "").toLowerCase() === email)?.id ?? null;
    if (data.users.length < 1000) break;
  }
  if (!authUserId) {
    return Response.json({ outcome, phoneSaved: true, authUpdated: false, error: "Saved on the staff account, but this person has no sign-in account yet, so the number cannot sign in." }, { status: 207 });
  }
  const res = await auth.supabase.auth.admin.updateUserById(authUserId, phone ? { phone, phone_confirm: true } : { phone: "" });
  if (res.error) {
    return Response.json({ outcome, phoneSaved: true, authUpdated: false, error: `Saved on the staff account, but the sign-in account was not updated: ${res.error.message}` }, { status: 207 });
  }
  return Response.json({ outcome, phoneSaved: true, authUpdated: true, last4: phone ? phoneLast4(phone) : null });
}
