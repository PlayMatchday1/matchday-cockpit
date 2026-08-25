// GET /api/admin/fields — every MatchDay field ID, and what it is mapped to.
//
// WHY A ROUTE AND NOT A CLIENT READ. The list is derived from ~9.7k match rows
// and ~94k paid registrations — a 100-page paged read that would make the page
// unusable in the browser. The service role is needed anyway, so the read is
// admin-gated here rather than depending on RLS policy drift.
//
// `?refresh=1` rebuilds the cached mdapi aggregate; the response always states
// when it was computed, so an operator is never guessing how old a number is.
// See src/lib/fieldIdAdminServer.ts for what is cached and what is not.

import { authenticateAdmin } from "@/lib/adminAuth";
import { fieldAggregate, fieldsPayload } from "@/lib/fieldIdAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    const agg = await fieldAggregate(auth.supabase, refresh);
    const payload = await fieldsPayload(auth.supabase, agg);
    return Response.json({ ok: true, ...payload });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
