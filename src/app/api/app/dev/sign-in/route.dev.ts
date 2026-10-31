// DEV ONLY: sign the staff app's simulator in as THE test account, with no text message (Ryan,
// 2026-10-30). The file ends in .dev.ts, and next.config adds that extension to pageExtensions only
// when NODE_ENV is development, so `next build` does not see this file as a route at all: a
// production deployment answers 404 here because the route does not exist in it.
//
// Inside development it still refuses unless:
//   - NODE_ENV is development (checked again here, not only by the build);
//   - the request reached the server on a loopback host, with no proxy forwarding header;
//   - the account is exactly TEST_EMAIL, an app_users row confined to Austin holding no admin flag
//     and no write grant. It never takes an email from the request, so it can sign in no one else.
//
// The session is minted with the service role: a magic link is generated for the account (nothing
// is sent) and verified at once with the publishable key, and the access and refresh tokens go back
// to the app, which installs them with supabase.auth.setSession.

import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_EMAIL = "staff-app-test@playmatchday.com";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WRITE_GRANTS = ["is_admin", "is_service_account", "can_edit_matches", "can_send_messages", "can_manage_players",
  "can_manage_promos", "can_edit_credits", "can_edit_memberships"] as const;

const notFound = () => new Response("Not Found", { status: 404 });

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") return notFound();
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const forwarded = req.headers.get("x-forwarded-for") ?? req.headers.get("forwarded");
  const ip = forwarded?.split(",")[0]?.trim() ?? null;
  if (!LOOPBACK.has(host) || (ip != null && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip))) return notFound();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !anonKey || !serviceKey) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const svc = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const row = await svc.from("app_users").select("*").ilike("email", TEST_EMAIL).maybeSingle();
  if (row.error || !row.data) return Response.json({ error: "The test staff account does not exist." }, { status: 409 });
  const r = row.data as Record<string, unknown>;
  const held = WRITE_GRANTS.filter((k) => r[k] === true);
  if (r.city_identifier !== "ATX" || held.length > 0) {
    return Response.json({ error: `The test account is not the read-only Austin account it must be (${held.join(", ") || `city ${String(r.city_identifier)}`}).` }, { status: 409 });
  }

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: TEST_EMAIL });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return Response.json({ error: `No link: ${link.error?.message ?? "no token"}` }, { status: 502 });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (v.error || !v.data.session) return Response.json({ error: `Not verified: ${v.error?.message ?? "no session"}` }, { status: 502 });
  return Response.json({ access_token: v.data.session.access_token, refresh_token: v.data.session.refresh_token });
}

export const GET = notFound;
