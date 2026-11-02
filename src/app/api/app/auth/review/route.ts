// Staff app: THE APP STORE REVIEW SIGN-IN (Ryan, 2026-11-02). Public: the caller is not signed in.
//
// The app tries this only after Supabase has refused a code, so everyone else's sign-in is what it
// was. It signs in REVIEW_EMAIL when the number is APP_REVIEW_PHONE and the code is APP_REVIEW_CODE,
// and nobody else, ever: there is no email or account in the request.
//
//   OFF       either env var empty: every request is refused, nothing is logged.
//   ANOTHER   any other number: refused, nothing logged (a staff member's mistyped code).
//   LOGGED    every attempt on the review number is a row in app_review_sign_ins.
//   LOCKED    after REVIEW_FAILS_PER_HOUR wrong codes in an hour the number is refused until it ages out.
//   SAFE      the account must still be Austin-confined with no admin flag and no write grant.
//
// The session is minted the way the dev sign-in route does it: a magic link for the account is
// generated with the service role (nothing is sent) and verified at once with the publishable key.

import { createClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { logReviewAttempt, REVIEW_EMAIL, reviewAccountSafe, REVIEW_FAILS_PER_HOUR, reviewCredentials, sameSecret } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO = () => Response.json({ error: "That code did not work." }, { status: 401 });

export async function POST(req: Request) {
  const creds = reviewCredentials();
  if (!creds) return NO();
  const body = (await req.json().catch(() => null)) as { phone?: unknown; code?: unknown } | null;
  const phone = normalizePhone(typeof body?.phone === "string" ? body.phone : null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!phone || phone !== normalizePhone(creds.phone)) return NO();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !anonKey || !serviceKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const svc = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const fails = await svc.from("app_review_sign_ins").select("id", { count: "exact", head: true }).eq("outcome", "wrong_code").gte("at", since);
  if (fails.error) return Response.json({ error: "Sign-in log unavailable." }, { status: 503 });
  if ((fails.count ?? 0) >= REVIEW_FAILS_PER_HOUR) {
    await logReviewAttempt(svc, req, "locked");
    return Response.json({ error: "Too many tries. Wait an hour and try again." }, { status: 429 });
  }
  if (!sameSecret(code, creds.code)) {
    await logReviewAttempt(svc, req, "wrong_code");
    return NO();
  }

  const row = await svc.from("app_users").select("*").ilike("email", REVIEW_EMAIL).maybeSingle();
  const r = (row.data ?? {}) as Record<string, unknown>;
  if (row.error || !row.data || !reviewAccountSafe(r)) {
    await logReviewAttempt(svc, req, "account_unsafe");
    console.error(`[review-sign-in] refused: the review account is missing or not the read-only Austin account it must be`);
    return NO();
  }

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: REVIEW_EMAIL });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return Response.json({ error: "Sign-in failed. Try again." }, { status: 502 });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (v.error || !v.data.session) return Response.json({ error: "Sign-in failed. Try again." }, { status: 502 });
  await logReviewAttempt(svc, req, "signed_in");
  return Response.json({ access_token: v.data.session.access_token, refresh_token: v.data.session.refresh_token });
}
