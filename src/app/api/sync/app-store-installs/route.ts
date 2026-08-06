// POST /api/sync/app-store-installs — on-demand trigger for ONLY the App Store
// Connect (iOS) install ingest, so it can be run without firing the whole nightly
// cron. The iOS mirror of /api/sync/play-installs.
//
// Auth is DUAL-MODE (same shape as /api/sync/play-installs):
//   Manual: Bearer <user-session-token> from the browser "Run now" button. The
//           session is validated (getUser) and REJECTED if invalid — but because
//           the ingest reads the privileged App Store Connect SA key and writes
//           app_downloads, the actual work runs with the SERVICE ROLE, not the
//           caller's RLS client.
//   Cron:   Bearer ${CRON_SECRET} (constant-time). Service-role client.
// Either way the ingest runs through runWithLog("app-store-installs") so the
// fin_sync_log row + KPI status stay consistent with the cron path.
//
// The response is SyncCard-compatible ({ ok, error, durationMs, result:{upserted} })
// AND carries the full diagnostic (vendor, day/units counts, retention edge, the
// per-Product-Type totals, the app_downloads(ios) summary, the fin_sync_log row).
// The .p8 private key is never read here beyond the lib's internal use, never
// logged, never returned.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import { ingestAppStore, AppleAuthError } from "@/lib/appStoreInstallsSync";

export const runtime = "nodejs";
export const maxDuration = 300;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json({ ok: false, error: "Missing Authorization header" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ ok: false, error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey || !publishableKey) {
    return Response.json({ ok: false, error: "Supabase env not configured" }, { status: 500 });
  }

  // Authorize: CRON_SECRET → cron; otherwise a valid user session → manual. An
  // absent/invalid session is rejected. Privileged work uses the service role in
  // both modes (SA key + app_downloads write), so the session is an AUTHZ gate only.
  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
  } else {
    const sessionClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ ok: false, error: "Invalid session" }, { status: 401 });
    }
    triggeredBy = "manual";
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const startedAt = Date.now();

  // Ingest through runWithLog so the run is persisted identically to the cron path
  // (KPI reads that row). AppleAuthError is normalized to a clear, stable message.
  const run = await runWithLog(
    "app-store-installs",
    triggeredBy,
    supabase,
    async () => {
      try {
        return await ingestAppStore(supabase, new Date());
      } catch (e) {
        if (e instanceof AppleAuthError) throw new Error(`App Store Connect auth failed: ${e.message}`);
        throw e;
      }
    },
    (r) => ({ rows_imported: r.rowsWritten }),
  );

  const summary = run.ok ? run.result : undefined;
  const runError = run.ok ? null : run.error;

  // Read back the truth: app_downloads(ios) summary + the freshest fin_sync_log row.
  const { count: adCount } = await supabase
    .from("app_downloads")
    .select("*", { count: "exact", head: true })
    .eq("platform", "ios");
  const { data: adMin } = await supabase
    .from("app_downloads")
    .select("period_date")
    .eq("platform", "ios")
    .order("period_date", { ascending: true })
    .limit(1);
  const { data: adMax } = await supabase
    .from("app_downloads")
    .select("period_date")
    .eq("platform", "ios")
    .order("period_date", { ascending: false })
    .limit(1);
  const { data: logRow } = await supabase
    .from("fin_sync_log")
    .select("source, triggered_by, started_at, completed_at, rows_imported, error_message")
    .eq("source", "app-store-installs")
    .order("started_at", { ascending: false })
    .limit(1);

  return Response.json(
    {
      ok: run.ok,
      error: runError,
      triggeredBy,
      durationMs: Date.now() - startedAt,
      result: { upserted: run.ok ? run.result.rowsWritten : undefined },
      vendor: summary?.vendor,
      daysFetched: summary?.daysFetched,
      daysWithData: summary?.daysWithData,
      unitsTotal: summary?.unitsTotal,
      earliest: summary?.earliest,
      latest: summary?.latest,
      retentionEdge: summary?.retentionEdge,
      productTypeTotals: summary?.productTypeTotals,
      appDownloadsIos: {
        rowCount: adCount ?? 0,
        minPeriodDate: adMin?.[0]?.period_date ?? null,
        maxPeriodDate: adMax?.[0]?.period_date ?? null,
      },
      finSyncLogRow: logRow?.[0] ?? null,
    },
    { status: 200 },
  );
}
