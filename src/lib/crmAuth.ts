// Shared dual-mode bearer auth for /api/crm/* routes.
//
// Same pattern as src/app/api/manager-pay/adjustments/route.ts and
// /api/sync/matches: accept either a Supabase session JWT or the
// CRON_SECRET. Session path additionally enforces corp gate via
// app_users.is_admin = true (CRM is corp-only for Phase 0).
//
// Returns a service-role Supabase client on success — callers use it
// for the actual DB work. appUserId is the app_users.id (uuid) on the
// session path, or null on the cron path (used as sent_by_user_id on
// outbound messages — null means "sent by server").

import "server-only";

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type CrmAuthOk = {
  ok: true;
  appUserId: string | null;
  email: string | null;
  // True iff the authenticated app_user has is_admin = true. False
  // for chats-only users (can_access_chats = true but is_admin =
  // false). Cron path (CRON_SECRET) sets this true since cron runs
  // with full server authority. Routes that need to gate admin-only
  // sub-features inside the chats domain (e.g. canned-response
  // mutations) check this flag explicitly.
  isAdmin: boolean;
  // True iff the authenticated app_user has can_access_chats = true
  // (independently of is_admin). Cron path sets this true. Routes for
  // chat-operator actions that used to be admin-only — close/reopen,
  // bulk-status — gate on (isAdmin || canAccessChats) so a chats-only
  // customer-service operator can fully work threads without Finance
  // or any other admin surface. Being an assignee is validated against
  // the same OR on the target user in the assign route.
  canAccessChats: boolean;
  supabase: SupabaseClient;
};

export type CrmAuthErr = { ok: false; status: number; error: string };

export type CrmAuthResult = CrmAuthOk | CrmAuthErr;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function authenticateCrm(req: Request): Promise<CrmAuthResult> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization header" };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return { ok: false, status: 500, error: "Supabase env not configured" };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
      ok: true,
      appUserId: null,
      email: null,
      isAdmin: true,
      canAccessChats: true,
      supabase: sb,
    };
  }

  const sessionClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sessionData, error: sessionErr } =
    await sessionClient.auth.getUser(token);
  if (sessionErr || !sessionData?.user?.email) {
    return { ok: false, status: 401, error: "Invalid session" };
  }
  const email = sessionData.user.email.toLowerCase();

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const appUser = await sb
    .from("app_users")
    .select("id, is_admin, can_access_chats")
    .ilike("email", email)
    .maybeSingle();
  if (appUser.error || !appUser.data) {
    return { ok: false, status: 403, error: "Not a cockpit user" };
  }
  const isAdmin = appUser.data.is_admin === true;
  const canAccessChats = appUser.data.can_access_chats === true;
  // Chats access gates the CRM API at the application layer. RLS on
  // crm_* tables enforces the same OR-clause underneath so this can't
  // be bypassed even if a route forgets to call authenticateCrm.
  // Admin-only sub-features (e.g. canned-response mutations) check
  // the returned isAdmin flag explicitly.
  if (!isAdmin && !canAccessChats) {
    return { ok: false, status: 403, error: "Chats access required" };
  }
  return {
    ok: true,
    appUserId: appUser.data.id as string,
    email,
    isAdmin,
    canAccessChats,
    supabase: sb,
  };
}
