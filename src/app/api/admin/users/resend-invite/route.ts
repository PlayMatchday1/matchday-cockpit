// Phase 30 — re-send a sign-in link.
//
// Before this, a silently-undelivered invite had NO recovery path inside Clubhouse: the auth
// identity already exists, so inviteUserByEmail refuses it as "already registered", and the only
// way to get someone in was the Supabase dashboard.
//
// This uses the SAME call the login screen makes (signInWithOtp with the anon key), because that
// is the one path that both works for an existing identity and actually delivers. It reports what
// it knows and nothing more: ACCEPTED at a timestamp, delivery unconfirmed.

import { authenticateAdmin } from "@/lib/adminAuth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = (body?.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return Response.json({ error: "Valid email required" }, { status: 400 });

  // The target must already be a cockpit user — this route sends mail, so it may not be pointed at
  // an arbitrary address.
  const known = await auth.supabase.from("app_users").select("id").eq("email", email).maybeSingle();
  if (!known.data) return Response.json({ error: "That email is not a cockpit user." }, { status: 404 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !anonKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const acceptedAt = new Date().toISOString();
  // shouldCreateUser:false — this re-sends to an existing identity and must never quietly create
  // a new one from a typo.
  const { error } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });

  if (error) {
    const msg = error.message ?? "";
    const rateLimited = /rate limit|too many|429/i.test(msg) || error.status === 429;
    return Response.json({
      ok: false,
      status: rateLimited ? "rate-limited" : "send-failed",
      email, emailAccepted: false, deliveryConfirmed: false,
      error: rateLimited
        ? `Refused by the auth email quota: ${msg}. Nothing was sent — wait and try again.`
        : `Send failed: ${msg}`,
    }, { status: rateLimited ? 429 : 502 });
  }

  return Response.json({
    ok: true, status: "accepted", email,
    emailAccepted: true, acceptedAt, deliveryConfirmed: false,
    message: `Supabase accepted a sign-in link at ${acceptedAt}. Delivery is NOT confirmed — this row shows Signed in only once they actually arrive.`,
  });
}
