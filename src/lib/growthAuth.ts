// Read-only auth for the Growth analytics API. Same session-bearer pattern as
// crmAuth, but gates on can_access_growth (the Growth tab's permission) instead
// of chats. Admins pass. Returns a service-role client so the route can read the
// mdapi_* mirror (SELECT is granted only TO authenticated; player emails would
// otherwise leak, so the aggregation happens server-side and only compact stats
// go to the client). This route never writes anything.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type CitiesAuthOk = { ok: true; email: string; supabase: SupabaseClient };
export type CitiesAuthErr = { ok: false; status: number; error: string };

export async function authenticateCities(
  req: Request,
): Promise<CitiesAuthOk | CitiesAuthErr> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization header" };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anon || !service) {
    return { ok: false, status: 500, error: "Supabase env not configured" };
  }

  const sessionClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user?.email) {
    return { ok: false, status: 401, error: "Invalid session" };
  }
  const email = data.user.email.toLowerCase();

  const sb = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const appUser = await sb
    .from("app_users")
    .select("is_admin, can_access_growth")
    .ilike("email", email)
    .maybeSingle();
  if (appUser.error || !appUser.data) {
    return { ok: false, status: 403, error: "Not a cockpit user" };
  }
  if (appUser.data.is_admin !== true && appUser.data.can_access_growth !== true) {
    return { ok: false, status: 403, error: "Growth access required" };
  }
  return { ok: true, email, supabase: sb };
}
