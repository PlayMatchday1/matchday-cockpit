// SYNC AND ADMIN ROUTES: CRON OR AN ADMIN, NOTHING ELSE (Ryan, 2026-11-02).
//
// These routes verified the bearer was a real Supabase session and stopped there, so any signed-in
// account (the review account included) could start a sync or write. Each still accepts CRON_SECRET
// first; a session must now also be an app_users admin, read fresh with the service role.
//
// GET: the routes Vercel cron calls keep a GET alias, because Vercel cron only sends GET. That alias
// now answers the cron secret alone (cronOnlyGet); people use POST.

import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => { const ab = Buffer.from(a), bb = Buffer.from(b); return ab.length === bb.length && timingSafeEqual(ab, bb); };
const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

/** Null when the verified session's email is an app_users admin; otherwise the refusal to return. */
export async function refuseUnlessAdmin(email: string | null | undefined): Promise<Response | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ ok: false, error: "Supabase env not configured" }, { status: 500 });
  if (!email) return Response.json({ ok: false, error: "Admins only." }, { status: 403 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // select("*"), the adminAuth precedent: a column that does not exist yet reads as undefined.
  const row = await sb.from("app_users").select("*").ilike("email", email).maybeSingle();
  if (row.error) return Response.json({ ok: false, error: "Staff lookup failed." }, { status: 503 });
  if (row.data?.is_admin !== true || row.data?.is_service_account === true) return Response.json({ ok: false, error: "Admins only." }, { status: 403 });
  return null;
}

/** MANAGER PAY CHANGES (Ryan, 2026-11-07): null when the verified session's email is an admin, or has
 *  the Manager pay box ticked (can_change_manager_pay, 0260); otherwise the refusal to return. The
 *  same row check as refuseUnlessAdmin with that one more way in, and nothing else changed. */
export async function refuseUnlessPayChanger(email: string | null | undefined): Promise<Response | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ ok: false, error: "Supabase env not configured" }, { status: 500 });
  if (!email) return Response.json({ ok: false, error: "Admins only." }, { status: 403 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const row = await sb.from("app_users").select("*").ilike("email", email).maybeSingle();
  if (row.error) return Response.json({ ok: false, error: "Staff lookup failed." }, { status: 503 });
  if (row.data?.is_service_account === true) return Response.json({ ok: false, error: "Admins only." }, { status: 403 });
  if (row.data?.is_admin === true || row.data?.can_change_manager_pay === true) return null;
  return Response.json({ ok: false, error: "Additional pay needs an admin or the Manager pay box on User access." }, { status: 403 });
}

/** Null when the verified session's email is on an app_users row (any staff member, not a service account). */
export async function refuseUnlessStaff(email: string | null | undefined): Promise<Response | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ ok: false, error: "Supabase env not configured" }, { status: 500 });
  if (!email) return Response.json({ ok: false, error: "Not a cockpit user" }, { status: 403 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const row = await sb.from("app_users").select("*").ilike("email", email).maybeSingle();
  if (row.error) return Response.json({ ok: false, error: "Staff lookup failed." }, { status: 503 });
  if (!row.data || row.data.is_service_account === true) return Response.json({ ok: false, error: "Not a cockpit user" }, { status: 403 });
  return null;
}

/** The GET alias for Vercel cron: the cron secret only; anyone else is told to use POST. */
export function cronOnlyGet(post: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const secret = process.env.CRON_SECRET;
    const token = bearer(req);
    if (!(secret && token && same(token, secret))) return Response.json({ ok: false, error: "GET is for the scheduled run only; use POST." }, { status: 405, headers: { Allow: "POST" } });
    return post(req);
  };
}
