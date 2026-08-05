// POST /api/sync/play-installs — on-demand trigger for ONLY the Google Play
// install ingest, so it can be run without firing the whole nightly cron.
// Guarded by CRON_SECRET (Bearer, constant-time), same as the cron's cron-mode.
// Uses the service role and runs the ingest through runWithLog("play-installs")
// exactly as the cron does, so the fin_sync_log row + KPI status stay consistent.
//
// Reports the raw GCS list result (verbatim 403/404), the objects the parser
// recognizes, rows written, and the resulting fin_sync_log row. The service
// account key is never read here, never logged, never returned.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWithLog } from "@/lib/syncLogging";
import {
  listInstalls,
  parseInstallFiles,
  ingestCurrentMonth,
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
    return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !constantTimeMatch(token, cronSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase service credentials not set" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const startedAt = Date.now();

  // 1) Raw GCS list — verbatim status/body so a 403 (grant) vs 404 (path) is
  //    unambiguous, plus the object inventory and which files the parser picks up.
  const list = await listInstalls();
  const bucketPath = `gs://${PLAY_BUCKET}/${PLAY_PREFIX}`;
  const recognized = list.ok ? parseInstallFiles((list.objects ?? []).map((o) => o.name)) : [];
  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // 2) Ingest the current month IFF the list succeeded — through runWithLog so the
  //    run is persisted identically to the cron path (KPI reads that row).
  let ingest: { ran: boolean; ok?: boolean; ym?: string; rows?: number; error?: string } = { ran: false };
  if (list.ok) {
    const run = await runWithLog(
      "play-installs",
      "cron",
      supabase,
      async () => {
        try {
          return await ingestCurrentMonth(supabase, new Date());
        } catch (e) {
          if (e instanceof PlayGrantPendingError) {
            throw new Error("Play grant still propagating (403) — expected for up to 24h after granting, non-fatal");
          }
          throw e;
        }
      },
      (r) => ({ rows_imported: r.rows }),
    );
    ingest = run.ok
      ? { ran: true, ok: true, ym: run.result.ym, rows: run.result.rows }
      : { ran: true, ok: false, error: run.error };
  }

  // 3) growth_downloads_month is a plain VIEW over app_downloads (live) — no
  //    refresh needed for the KPI. Refresh the other growth_* matviews anyway so
  //    any download-derived series stay coherent; best-effort, never fatal.
  if (ingest.ok && (ingest.rows ?? 0) > 0) await refreshGrowthViews(supabase);

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

  return Response.json(
    {
      durationMs: Date.now() - startedAt,
      package: PLAY_PACKAGE,
      gcsList: {
        bucketPath,
        ok: list.ok,
        httpStatus: list.status,
        statusText: list.statusText,
        kind: list.ok ? "success" : list.status === 403 ? "403-forbidden" : list.status === 404 ? "404-not-found" : "error",
        error: list.error ?? null,
        objectCount: list.objects?.length ?? 0,
        objects: (list.objects ?? []).map((o) => ({ name: o.name, updated: o.updated, bytes: o.size })),
        parserRecognizedFiles: recognized.map((f) => ({ name: f.name, ym: f.ym, pkg: f.pkg })),
        currentMonthTargeted: currentYm,
      },
      ingest,
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
