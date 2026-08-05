// POST /api/sync/telnyx-sms — manual trigger for the Telnyx outbound-SMS
// ingest into telnyx_sms_log. Backs the SyncCard "Sync now" button on
// /data → Telnyx SMS section.
//
// A dedicated /api/sms-log/ingest already exists for the /sms-log
// dashboard's "fetch recent" catch-up, but it does NOT write a
// fin_sync_log row — so a SyncCard pointed at it would always read "Never
// synced". This route mirrors the other per-source sync endpoints exactly
// (dual-mode auth + runWithLog("telnyx-sms")) so the Data-page card has
// real freshness + failure visibility, which is the whole point of the
// card.
//
// Auth: same dual-mode pattern as /api/sync/reviews.
//   Manual: Bearer <user-session-token> from the browser. Session is
//           validated via getUser and REJECTED if invalid (401) — but
//           telnyx_sms_log is SELECT-only for authenticated by design, so
//           the ingest's upsert/prune run with the SERVICE ROLE, not the
//           caller's RLS client. The session is an AUTHZ gate only.
//   Cron:   Bearer ${CRON_SECRET} (constant-time). Service-role client.
//
// 2-day lookback (matches the cron): upsert-on-telnyx_message_id makes the
// overlap idempotent, so a run straddling the day boundary loses nothing.
//
// On success: 200 with { ok: true, result: { rowsUpserted, ... } }.
// On failure: 500 with { ok: false, error: "..." }.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ingestTelnyxSms } from "@/lib/telnyxSmsIngest";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// Lists Telnyx MDRs + fetches per-message bodies in throttled batches over
// a 2-day window (~35 outbound/day sample). ~15s typical; 120s headroom.
export const maxDuration = 120;
export const runtime = "nodejs";

// 2-day lookback, mirroring the cron orchestrator's telnyx-sms step.
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  // --- Auth: bearer, dual-mode ---
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header" },
      { status: 401 },
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  if (!serviceKey) {
    return Response.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set" },
      { status: 500 },
    );
  }

  // Authorize: CRON_SECRET → cron; otherwise a valid user session → manual.
  // telnyx_sms_log is SELECT-only for authenticated, so the ingest uses the
  // service role in BOTH modes — the session is validated for authz only.
  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
  } else {
    const sessionClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
    triggeredBy = "manual";
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- Run with logging ---
  const sinceISO = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const result = await runWithLog(
    "telnyx-sms",
    triggeredBy,
    supabase,
    (sb) => ingestTelnyxSms(sb, { sinceISO }),
    (r) => ({ rows_imported: r.rowsUpserted }),
  );

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      ...result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
