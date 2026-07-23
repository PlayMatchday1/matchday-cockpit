// GET /api/crm/operators — list of operators eligible for thread
// assignment. Populates the assignment dropdown in the conversation
// header. Eligible = app_users with is_admin = true OR
// can_access_chats = true, so a chats-only customer-service operator
// can be assigned threads without holding any admin surface. The
// write-side assign route validates the same OR on the target.
//
// Cached once per page load on the client; cheap to refetch on demand
// (≤10 rows expected for the foreseeable future).
//
// Auth: dual-mode bearer via src/lib/crmAuth.
//
// Response: { operators: Array<{ id, email, full_name }> }

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const res = await supabase
    .from("app_users")
    .select("id, email, full_name")
    .or("is_admin.eq.true,can_access_chats.eq.true")
    .order("full_name", { ascending: true, nullsFirst: false });
  if (res.error) {
    console.error("[crm:operators] db error", res.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  return Response.json({ operators: res.data ?? [] }, { status: 200 });
}
