// POST /api/sync/stripe — pull charges from the Stripe API and commit
// them to fin_revenue using the same path the manual CSV importer
// uses. Manual button on /admin/finance/upload calls this; Phase 2
// will add a Vercel cron caller using a different auth mechanism.
//
// Auth model: Bearer token from the user's Supabase session. The
// browser reads session.access_token from the existing supabase
// client and forwards it; we build a per-request authenticated
// Supabase client with that token so RLS evaluates as the caller.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { commitStripe } from "@/lib/financeImport";
import { syncStripeCharges } from "@/lib/stripeSync";

// Stripe pagination + commit can run long; default Vercel timeout is
// 10s on Hobby. Bump to the per-route max — App Router exports.
export const maxDuration = 60;
// Force Node runtime — Stripe SDK uses Node APIs.
export const runtime = "nodejs";

type RequestBody = {
  since?: string; // ISO date or datetime
  until?: string; // ISO date or datetime
};

function parseDateParam(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Default `since`: max(date) of existing Stripe rows in fin_revenue.
// Falls back to 30 days ago if there are no rows yet (cold-start). The
// commit's date-range-replace logic deletes overlapping rows, so
// re-fetching from max(date) is idempotent.
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

  // --- Auth: Bearer token → authenticated Supabase client ---
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json({ error: "Missing Authorization header" }, { status: 401 });
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
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the token resolves to a user. getUser() hits Supabase auth
  // server — confirms the token is valid and not stale.
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return Response.json({ error: "Invalid session" }, { status: 401 });
  }

  // --- Parse window ---
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // Empty body is fine — defaults will fill in.
  }
  const since = parseDateParam(body.since) ?? (await defaultSince(supabase));
  const until = parseDateParam(body.until) ?? new Date();

  if (since > until) {
    return Response.json(
      { error: "since must be on or before until" },
      { status: 400 },
    );
  }

  // --- Sync + commit ---
  try {
    const sync = await syncStripeCharges(supabase, { since, until });
    let commitNote: string | undefined;
    if (sync.rows.length > 0 && sync.earliestDate && sync.latestDate) {
      const result = await commitStripe(
        {
          rows: sync.rows,
          earliestDate: sync.earliestDate,
          latestDate: sync.latestDate,
        },
        supabase,
      );
      commitNote = result.note;
    }
    return Response.json({
      since: since.toISOString(),
      until: until.toISOString(),
      totalCharges: sync.totalCharges,
      paidRows: sync.paidRows,
      skippedNonPaid: sync.skippedNonPaid,
      skippedNonUsd: sync.skippedNonUsd,
      rowsImported: sync.rows.length,
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
    return Response.json(
      { error: msg, durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
