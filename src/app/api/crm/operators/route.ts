// GET /api/crm/operators — list of corp operators eligible for
// thread assignment. Populates the assignment dropdown in the
// conversation header. Phase 1 = app_users where is_admin = true.
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
    .eq("is_admin", true)
    .order("full_name", { ascending: true, nullsFirst: false });
  if (res.error) {
    console.error("[crm:operators] db error", res.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  return Response.json({ operators: res.data ?? [] }, { status: 200 });
}
