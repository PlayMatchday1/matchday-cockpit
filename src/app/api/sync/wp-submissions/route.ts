// POST /api/sync/wp-submissions — the nightly mirror of playmatchday.com form submissions.
//
// READ-ONLY AGAINST THE SITE. Every Graph-side request is a GET and the host guard refuses any URL
// whose PARSED host is not the configured one; redirects are refused rather than followed, because
// a 301 would hand our key to whatever it points at. The key travels in an X-MD-Key header, never
// a query parameter, and every error passes through redactWp.
//
// INCREMENTAL FROM WHAT WE HOLD. Paging starts at max(submission_id), not zero — a full re-walk
// every night is 664 rows of nothing. It stops when next_after_id comes back null.
//
// A FAILED RUN CHANGES NOTHING AND SAYS FAILED. Reads retry ONCE on a 5xx and never more; a
// partial import that looks complete is the failure mode this whole route is shaped against.
//
// CONTACTS ARE INSERTED, NEVER UPDATED. An existing contact keeps its status, owner and notes
// whatever arrives — outreach attaches to the person, and a nightly job that reset someone's
// status because they applied again would destroy the only signal the page carries.
//
// Same dual-mode auth as the other sync routes: CRON_SECRET for the scheduled call, a valid
// session for a manual one. Writes use the service role.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { syncWpSubmissions, type WpSyncResult } from "@/lib/wpSubmissionsSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

/* An incremental walk from the highest id we hold — a normal night is one page of a handful of
 * rows plus two small writes. 120s is generous. The number to watch is completed_at - started_at
 * in fin_sync_log for 'wp-submissions'; a first run after a long gap is the only slow case. */
export const maxDuration = 120;
export const runtime = "nodejs";

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
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
    triggeredBy = "cron";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
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
    triggeredBy = "manual";
    // Manual mode needs the service role too — RLS allows SELECT only
    // on mdapi_users for authenticated, no INSERT/UPDATE policy.
    // Verify the session token is valid before swapping in service.
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!serviceKey) {
      return Response.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is not set" },
        { status: 500 },
      );
    }
    supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /* --- Run with logging ---
   * runWithLog INSERTS THE LOG ROW BEFORE RUNNING THE SYNC and returns ok:false without running it
   * if that insert is rejected. So until migration 0149 adds 'mdapi-users-full' to the source CHECK
   * this route does nothing at all — and says so, rather than reporting a success it did not have.
   * That is the loud direction: a re-sync that quietly skipped would leave scrubbed accounts
   * readable while Recent Syncs showed nothing wrong. */
  const result = await runWithLog(
    "wp-submissions",
    triggeredBy,
    supabase,
    (sb) => syncWpSubmissions(sb),
    (r: WpSyncResult) => ({
      rows_imported: r.newSubmissions,
      rows_replaced: r.updatedSubmissions,
      /* THE TWO THINGS THAT GO WRONG SILENTLY, both in the verdict rather than only in a return
       * value nobody reads. An UNSEEN element_id means a form was edited and its submissions now
       * resolve to nothing — that is how five Team Application forms came to exist. DRIFT is
       * reported and never acted on: a shortfall means someone deleted a submission in WordPress,
       * and this mirror is supposed to outlive that. */
      error_message: (() => {
        const bits: string[] = [];
        const un = Object.entries(r.unresolvedByElement);
        if (un.length) bits.push(`UNRESOLVED FORMS: ${un.map(([e, n]) => `${e}=${n}`).join(", ")} — labels not recoverable; raw keys kept`);
        if (r.drift != null && r.drift !== 0) bits.push(`DRIFT: source ${r.sourceCount} vs held ${r.heldCount} (${r.drift > 0 ? "+" : ""}${r.drift}) — reported, nothing deleted`);
        return bits.length ? `ADVISORY (sync OK): ${bits.join(" · ")}` : undefined;
      })(),
    }),
  );

  if (!result.ok && /fin_sync_log_source_check|violates check constraint/i.test(result.error ?? "")) {
    return Response.json({
      error: "Migration 0153 (fin_sync_log source 'wp-submissions') is not applied yet. NOTHING WAS SYNCED.",
      detail: result.error,
    }, { status: 503 });
  }

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      ...result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
