// Phase 30 — who has actually signed in.
//
// app_users says what someone is ALLOWED to do; auth.users says whether they ever arrived. The
// grid only ever read the first, so an account whose invite silently never landed looked exactly
// like one that was working. These three timestamps are the difference, and they live in
// auth.users, which is only reachable with the service role — hence a route rather than a client
// read.
//
// No permission flags are returned here and no email is echoed beyond the ones the caller can
// already see in the grid they are looking at.

import { authenticateAdmin } from "@/lib/adminAuth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const byEmail: Record<string, { invitedAt: string | null; confirmedAt: string | null; lastSignInAt: string | null }> = {};
  for (const u of data.users) {
    const e = (u.email ?? "").toLowerCase();
    if (!e) continue;
    byEmail[e] = {
      invitedAt: u.invited_at ?? null,
      // confirmed_at is the moment they actually followed a link — the only proof of delivery
      // this system ever gets.
      confirmedAt: (u.email_confirmed_at ?? u.confirmed_at) ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
    };
  }
  return Response.json({ ok: true, users: byEmail });
}
