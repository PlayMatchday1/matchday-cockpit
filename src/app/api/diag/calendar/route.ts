// GET /api/diag/calendar — TEMPORARY. Same session auth as the /data sync cards.
// Uses the caller's session identity as the impersonation subject, then makes ONE
// live delegated Calendar events.list for the current week. Returns only status /
// counts / verbatim error — never a token or the service-account key. Delete this
// route + the trigger card once the calendar state is understood.

import { createClient } from "@supabase/supabase-js";
import { probeCalendar } from "@/lib/calendarDiag";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return Response.json({ error: "Empty bearer token" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !publishableKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });

  const sessionClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user?.email) return Response.json({ error: "Invalid session" }, { status: 401 });

  try {
    const probe = await probeCalendar(data.user.email); // impersonate the caller's own calendar
    return Response.json(probe, { status: 200 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
