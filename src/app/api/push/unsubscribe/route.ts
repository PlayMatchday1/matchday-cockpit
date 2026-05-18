// POST /api/push/unsubscribe — remove a Web Push subscription for
// the current admin viewer.
//
// Body: { endpoint }
//
// Auth: dual-mode bearer via src/lib/crmAuth. Session path only.
//
// Idempotent: deletes the (user_id, endpoint) row if it exists.
// Returns success even if no row was deleted so the client can
// retry safely.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

type UnsubscribeBody = { endpoint?: unknown };

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json(
      { error: "unsubscribe requires a viewer; cron path is not supported" },
      { status: 400 },
    );
  }

  let parsed: UnsubscribeBody;
  try {
    parsed = (await req.json()) as UnsubscribeBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
  if (!endpoint) {
    return Response.json({ error: "endpoint required" }, { status: 400 });
  }

  const del = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", appUserId)
    .eq("endpoint", endpoint);
  if (del.error) {
    console.error("[push:unsubscribe] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
