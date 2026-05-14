// POST /api/sync/stripe — pull charges from the Stripe API and commit
// them to fin_revenue. Two auth modes:
//
//   Manual: browser sends Authorization: Bearer <user_session_token>
//     from the upload page button. Per-request authenticated Supabase
//     client with that token; RLS evaluates as the calling user.
//
//   Cron: Vercel cron sends Authorization: Bearer ${CRON_SECRET}.
//     Route validates the secret with constant-time comparison and
//     uses the Supabase service role for DB writes (bypasses RLS,
//     since cron has no user identity).
//
// Every attempt — success or failure — writes a row to fin_sync_log
// with started_at + counts (or error_message). The sync-log row is
// inserted at the start so crashed syncs still leave a trace.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { commitStripe } from "@/lib/financeImport";
import { syncStripeCharges } from "@/lib/stripeSync";

// Bumped from 60s to 300s on 2026-05-14 after a Jan 1-7 backfill
// click via the new date-range UI hit Vercel's function-timeout
// wall mid-pagination — 7-day historical windows pull ~7× more
// charges than the default daily catch-up. 300s matches the budget
// /api/sync/matches uses for the same reason; daily catch-up still
// finishes in 3-13s well under the new ceiling.
export const maxDuration = 300;
export const runtime = "nodejs";

type RequestBody = {
  since?: string;
  until?: string;
};
type TriggeredBy = "manual" | "cron";

function parseDateParam(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Constant-time comparison of two strings of arbitrary length. Avoids
// timing oracles on the cron secret check.
function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function defaultSince(supabase: SupabaseClient): Promise<Date> {
  const { data, error } = await supabase
    .from("fin_revenue")
    .select("date")
    .eq("source", "Stripe")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle<{ date: string }>();
  if (error || !data?.date) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() - 30);
    return fallback;
  }
  return new Date(`${data.date}T00:00:00Z`);
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  // --- Auth: bearer token, dual-mode ---
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
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  let supabase: SupabaseClient;

  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    // Cron mode — service role bypasses RLS for the writes the cron
    // user has no authenticated identity to satisfy.
    triggeredBy = "cron";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return Response.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is not set" },
        { status: 500 },
      );
    }
    supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else {
    // Manual mode — validate the token resolves to a user, then use
    // it for the per-request authenticated client. RLS evaluates as
    // the calling user.
    triggeredBy = "manual";
    supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }

  // --- Insert fin_sync_log row at the start so a crash leaves a trace ---
  const { data: logInsert, error: logErr } = await supabase
    .from("fin_sync_log")
    .insert({
      source: "stripe-api",
      triggered_by: triggeredBy,
      started_at: startedAtIso,
    })
    .select("id")
    .single();
  if (logErr || !logInsert) {
    return Response.json(
      { error: `Failed to create sync log row: ${logErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
  const logId = logInsert.id as string;

  // Helper: stamp a final state on the log row. Failure to update
  // the log itself is non-fatal — the API response is the
  // authoritative result either way.
  async function finalizeLog(patch: Record<string, unknown>) {
    const { error } = await supabase
      .from("fin_sync_log")
      .update({ completed_at: new Date().toISOString(), ...patch })
      .eq("id", logId);
    if (error) console.warn("fin_sync_log update failed:", error.message);
  }

  // --- Parse window ---
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // Empty body is fine — defaults will fill in. Cron sends none.
  }
  const since = parseDateParam(body.since) ?? (await defaultSince(supabase));
  const until = parseDateParam(body.until) ?? new Date();

  if (since > until) {
    await finalizeLog({ error_message: "since must be on or before until" });
    return Response.json(
      { error: "since must be on or before until" },
      { status: 400 },
    );
  }

  // --- Sync + commit ---
  try {
    const sync = await syncStripeCharges(supabase, { since, until });
    let rowsReplaced = 0;
    let commitNote: string | undefined;

    // Cron: commit even if 0 rows so the log row records a successful
    // empty run. Manual: also commits empty (early-return inside
    // commitStripe handles row.length === 0 with note + count=0).
    if (sync.rows.length > 0 && sync.earliestDate && sync.latestDate) {
      const result = await commitStripe(
        {
          rows: sync.rows,
          earliestDate: sync.earliestDate,
          latestDate: sync.latestDate,
        },
        supabase,
      );
      rowsReplaced = result.rowsReplaced ?? 0;
      commitNote = result.note;
    }

    const chargesSkipped = sync.skippedNonPaid + sync.skippedNonUsd;
    await finalizeLog({
      rows_imported: sync.rows.length,
      rows_replaced: rowsReplaced,
      charges_fetched: sync.totalCharges,
      charges_succeeded: sync.paidRows,
      charges_skipped: chargesSkipped,
    });

    return Response.json({
      logId,
      triggeredBy,
      since: since.toISOString(),
      until: until.toISOString(),
      totalCharges: sync.totalCharges,
      paidRows: sync.paidRows,
      skippedNonPaid: sync.skippedNonPaid,
      skippedNonUsd: sync.skippedNonUsd,
      rowsImported: sync.rows.length,
      rowsReplaced,
      earliestDate: sync.earliestDate,
      latestDate: sync.latestDate,
      membershipPayments: sync.membershipPayments,
      matchPayments: sync.matchPayments,
      strikePayments: sync.strikePayments,
      unmatchedEmails: sync.unmatchedEmails,
      unmatchedCityCodes: sync.unmatchedCityCodes,
      durationMs: Date.now() - startedAt,
      note: commitNote,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finalizeLog({ error_message: msg });
    return Response.json(
      { logId, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
