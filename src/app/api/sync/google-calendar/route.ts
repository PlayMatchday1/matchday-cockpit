// POST /api/sync/google-calendar — on-demand trigger for ONLY the Google Calendar
// sync, so it can be run without firing the whole nightly cron. Mirrors
// /api/sync/app-store-installs.
//
// Auth is DUAL-MODE (same shape as /api/sync/app-store-installs):
//   Manual: Bearer <user-session-token> from the browser "Run now" button. The
//           session is validated (getUser) and REJECTED if invalid — but because
//           the sync reads the privileged service-account key and writes the
//           service-role-only calendar_* tables, the actual work runs with the
//           SERVICE ROLE, not the caller's RLS client.
//   Cron:   Bearer ${CRON_SECRET} (constant-time). Service-role client.
// Either way the sync runs through runWithLog("google-calendar") so the
// fin_sync_log row + KPI status stay consistent with the cron path.
//
// The response is SyncCard-compatible ({ ok, error, triggeredBy, durationMs,
// result:{upserted}, counters }). It also carries a non-secret `saComparison`
// object contrasting the Calendar SA and the Play SA — ONLY the local part before
// @ and the project_id, NEVER the key or private_key. The service-account key is
// never read here beyond the lib's internal use, never logged, never returned.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import { syncAllCalendars, CalendarConfigError } from "@/lib/calendarSync";

export const runtime = "nodejs";
export const maxDuration = 120;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Parse a service-account JSON blob (raw JSON or base64→JSON) and return ONLY the
// non-secret local part + project id. Never returns the key or private_key.
function saIdentity(
  raw: string | undefined,
  mode: "json" | "b64",
): { clientEmailLocalPart: string | null; projectId: string | null } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let sa: { client_email?: string; project_id?: string };
  try {
    if (mode === "b64") {
      sa = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
    } else {
      // Calendar may be raw JSON or base64→JSON.
      try {
        sa = JSON.parse(trimmed);
      } catch {
        sa = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
      }
    }
  } catch {
    return null;
  }
  const email = sa.client_email ?? "";
  return {
    clientEmailLocalPart: email.includes("@") ? email.split("@")[0] : email || null,
    projectId: sa.project_id ?? null,
  };
}

// Compute the non-secret Calendar-vs-Play SA comparison for the report. Wrapped by
// the caller in try/catch so a parse failure sets saComparison:null rather than
// breaking the response.
function buildSaComparison() {
  const calendar = saIdentity(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "json");
  const play = saIdentity(process.env.GOOGLE_PLAY_SA_KEY_B64, "b64");
  return {
    calendar,
    play,
    sameClientEmail:
      !!calendar?.clientEmailLocalPart &&
      calendar.clientEmailLocalPart === play?.clientEmailLocalPart,
    sameProject: !!calendar?.projectId && calendar.projectId === play?.projectId,
  };
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
  // both modes (SA key + service-role-only calendar_* tables), so the session is
  // an AUTHZ gate only.
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

  // Sync through runWithLog so the run is persisted identically to the cron path
  // (KPI reads that row). CalendarConfigError is normalized to a clear, stable
  // message; a no-op run (no accounts / all-failed) throws inside the lib and is
  // recorded as a failure — intentionally not weakened here.
  const run = await runWithLog(
    "google-calendar",
    triggeredBy,
    supabase,
    async () => {
      try {
        return await syncAllCalendars(supabase, new Date());
      } catch (e) {
        if (e instanceof CalendarConfigError) throw new Error(`Calendar sync config: ${e.message}`);
        throw e;
      }
    },
    (r) => ({ rows_imported: r.eventsStored }),
  );

  // Non-secret SA comparison for the report. Wrapped so a parse failure can't break
  // the response.
  let saComparison: ReturnType<typeof buildSaComparison> | null = null;
  try {
    saComparison = buildSaComparison();
  } catch {
    saComparison = null;
  }

  return Response.json(
    {
      ok: run.ok,
      error: run.ok ? null : run.error,
      triggeredBy,
      durationMs: Date.now() - startedAt,
      result: { upserted: run.ok ? run.result.eventsStored : undefined },
      counters: run.ok ? run.result : undefined,
      saComparison,
    },
    { status: 200 },
  );
}
