// POST /api/sync/play-installs — on-demand trigger for ONLY the Google Play
// install ingest, so it can be run without firing the whole nightly cron.
//
// Auth is DUAL-MODE (same shape as /api/sync/reviews):
//   Manual: Bearer <user-session-token> from the browser "Run now" button. The
//           session is validated (getUser) and REJECTED if invalid — but because
//           the ingest reads the privileged SA key and writes app_downloads, the
//           actual work runs with the SERVICE ROLE, not the caller's RLS client.
//   Cron:   Bearer ${CRON_SECRET} (constant-time). Service-role client.
// Either way the ingest runs through runWithLog("play-installs") so the
// fin_sync_log row + KPI status stay consistent with the cron path.
//
// The response is SyncCard-compatible ({ ok, error, durationMs, result:{upserted} })
// AND carries the full diagnostic (verbatim GCS 403/404, object inventory, the
// files the parser consumed, the fin_sync_log row). The service account key is
// never read here beyond auth, never logged, never returned.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import {
  listInstalls,
  ingestAllMonths,
  type IngestSummary,
  PlayGrantPendingError,
  PLAY_BUCKET,
  PLAY_PREFIX,
  PLAY_PACKAGE,
} from "@/lib/playInstallsSync";
import { refreshGrowthViews } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
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

  // 1) Raw GCS list — verbatim status/body so a 403 (grant) vs 404 (path) is
  //    unambiguous, plus the FULL object inventory (names/sizes/dates).
  const list = await listInstalls();
  const bucketPath = `gs://${PLAY_BUCKET}/${PLAY_PREFIX}`;

  // Echo the full listing to the function log (names/sizes/dates only — no secrets)
  // so the real bucket naming is retrievable from runtime logs, not just the HTTP
  // response. This is what replaced constructing filenames.
  if (list.ok) {
    console.log("[play-installs] bucket listing", JSON.stringify({ count: list.objects?.length ?? 0, objects: list.objects }));
  }

  // 2) Ingest EVERY available month IFF the list succeeded — driven by the real
  //    filenames (derives the actual package, re-downloads every month in full so
  //    late restatements overwrite). Runs through runWithLog so the run is persisted
  //    identically to the cron path (KPI reads that row).
  let ingest: { ran: boolean; ok?: boolean; error?: string; summary?: IngestSummary } = { ran: false };
  if (list.ok) {
    const run = await runWithLog(
      "play-installs",
      triggeredBy,
      supabase,
      async () => {
        try {
          return await ingestAllMonths(supabase, list.objects ?? [], new Date());
        } catch (e) {
          if (e instanceof PlayGrantPendingError) {
            throw new Error("Play grant still propagating (403) — expected for up to 24h after granting, non-fatal");
          }
          throw e;
        }
      },
      (r) => ({ rows_imported: r.rowsWritten }),
    );
    ingest = run.ok ? { ran: true, ok: true, summary: run.result } : { ran: true, ok: false, error: run.error };
  }
  const rowsWritten = ingest.summary?.rowsWritten ?? 0;

  // 3) growth_downloads_month is a plain VIEW over app_downloads (live) — no
  //    refresh needed for the KPI. Refresh the other growth_* matviews anyway so
  //    any download-derived series stay coherent; best-effort, never fatal.
  if (ingest.ok && rowsWritten > 0) await refreshGrowthViews(supabase);

  // 4) Read back the truth: app_downloads summary + the freshest fin_sync_log row.
  const { count: adCount } = await supabase
    .from("app_downloads")
    .select("*", { count: "exact", head: true })
    .eq("platform", "android");
  const { data: adMin } = await supabase
    .from("app_downloads")
    .select("period_date")
    .order("period_date", { ascending: true })
    .limit(1);
  const { data: adMax } = await supabase
    .from("app_downloads")
    .select("period_date")
    .order("period_date", { ascending: false })
    .limit(1);
  const { data: logRow } = await supabase
    .from("fin_sync_log")
    .select("source, triggered_by, started_at, completed_at, rows_imported, error_message")
    .eq("source", "play-installs")
    .order("started_at", { ascending: false })
    .limit(1);
  const { data: viewRows } = await supabase.from("growth_downloads_month").select("month, count").order("month");

  // Top-level SyncCard contract: ok + one verbatim error string + result.upserted.
  // A GCS list failure (403/404) is the error the operator most needs to see, so it
  // takes precedence; otherwise an ingest failure; otherwise success with the count.
  const ok = list.ok && ingest.ok === true;
  const error = !list.ok
    ? `GCS list ${list.status === 403 ? "403 (grant missing/insufficient)" : list.status === 404 ? "404 (bad bucket path)" : list.status || "error"}: ${list.error ?? list.statusText}`
    : ingest.ok === false
      ? ingest.error ?? "ingest failed"
      : null;

  const s = ingest.summary;
  return Response.json(
    {
      ok,
      error,
      triggeredBy,
      durationMs: Date.now() - startedAt,
      result: { upserted: ingest.ok ? rowsWritten : undefined },
      // Package DERIVED from the real filenames (not the hardcoded default).
      configuredPackageDefault: PLAY_PACKAGE,
      derivedPackage: s?.chosenPackage ?? null,
      otherPackages: s?.otherPackages ?? [],
      monthsAvailable: s?.availableMonths ?? [],
      monthsIngested: s?.ingestedMonths ?? [],
      perMonth: s?.perMonth ?? [],
      gcsList: {
        bucketPath,
        ok: list.ok,
        httpStatus: list.status,
        statusText: list.statusText,
        kind: list.ok ? "success" : list.status === 403 ? "403-forbidden" : list.status === 404 ? "404-not-found" : "error",
        error: list.error ?? null,
        objectCount: list.objects?.length ?? 0,
        objects: (list.objects ?? []).map((o) => ({ name: o.name, updated: o.updated, bytes: o.size })),
      },
      appDownloads: {
        androidRowCount: adCount ?? 0,
        minPeriodDate: adMin?.[0]?.period_date ?? null,
        maxPeriodDate: adMax?.[0]?.period_date ?? null,
      },
      growthDownloadsMonthView: {
        rowCount: viewRows?.length ?? 0,
        months: viewRows ?? [],
      },
      finSyncLogRow: logRow?.[0] ?? null,
    },
    { status: 200 },
  );
}
