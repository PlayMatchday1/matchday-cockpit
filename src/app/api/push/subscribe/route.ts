// POST /api/push/subscribe — register or refresh a Web Push
// subscription for the current admin viewer.
//
// Body: { endpoint, p256dh, auth, user_agent? }
//
// Auth: dual-mode bearer via src/lib/crmAuth. Session path only —
// cron has no browser endpoint to register.
//
// Upsert keyed on (user_id, endpoint). last_seen_at is bumped on
// every subscribe call so the UI's defensive re-subscribe on PWA
// launch refreshes the freshness timestamp.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

type SubscribeBody = {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
  user_agent?: unknown;
};

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json(
      { error: "subscribe requires a viewer; cron path is not supported" },
      { status: 400 },
    );
  }

  let parsed: SubscribeBody;
  try {
    parsed = (await req.json()) as SubscribeBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
  const p256dh = typeof parsed.p256dh === "string" ? parsed.p256dh : "";
  const authKey = typeof parsed.auth === "string" ? parsed.auth : "";
  const userAgent =
    typeof parsed.user_agent === "string" ? parsed.user_agent.slice(0, 500) : null;

  if (!endpoint) {
    return Response.json({ error: "endpoint required" }, { status: 400 });
  }
  if (!p256dh || !authKey) {
    return Response.json(
      { error: "p256dh and auth required" },
      { status: 400 },
    );
  }
  // Endpoints come from browser push services (FCM, Apple, Mozilla).
  // Sanity bound — real endpoints are <200 chars but defending here
  // keeps a misuse from blowing up the row.
  if (endpoint.length > 2048) {
    return Response.json({ error: "endpoint too long" }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const upsert = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: appUserId,
        endpoint,
        p256dh,
        auth: authKey,
        user_agent: userAgent,
        last_seen_at: nowIso,
      },
      { onConflict: "user_id,endpoint" },
    );
  if (upsert.error) {
    console.error("[push:subscribe] upsert failed", upsert.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
