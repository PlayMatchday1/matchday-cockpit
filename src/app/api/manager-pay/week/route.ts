// GET /api/manager-pay/week?week=YYYY-MM-DD
//
// The ADMIN/STAFF view of one week. Thin wrapper around managerPayCompute.ts
// (shared with the cron recompute) plus the arrival estimate + override.
//
// Auth: a valid session is REQUIRED (401 without one). This route no longer
// serves anonymous callers — the public, read-only surface is the purpose-built
// /api/manager-pay/shared endpoint (token-authed, whitelisted fields). Keeping a
// "public flag" branch here is exactly the drift hazard we moved away from.
//
// A valid session → isAdmin:true (emails populated). CRON_SECRET is still accepted
// for the recompute/self-check path.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { computeManagerPayForWeek, ISO_DATE_RX, weekdayUtc } from "@/lib/managerPayCompute";
import { getArrivalInfo } from "@/lib/managerPayArrival";

export const runtime = "nodejs";
export const maxDuration = 30;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Require a valid caller: CRON_SECRET, or a real Supabase session. 401 otherwise
// — no anonymous access.
async function requireSession(req: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return { ok: false, status: 401, error: "Missing Authorization header" };
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return { ok: false, status: 500, error: "Supabase env not configured" };

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && constantTimeMatch(token, cronSecret)) return { ok: true };

  const sessionClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: "Invalid session" };
  return { ok: true };
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }

  const gate = await requireSession(req);
  if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.status });

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  if (!weekParam || !ISO_DATE_RX.test(weekParam)) {
    return Response.json({ error: "Missing or malformed ?week=YYYY-MM-DD" }, { status: 400 });
  }
  if (weekdayUtc(weekParam) !== 1) {
    return Response.json({ error: "?week must be a Monday (YYYY-MM-DD)" }, { status: 400 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const payload = await computeManagerPayForWeek(supabase, weekParam, { isAdmin: true });
    const arrival = await getArrivalInfo(supabase, weekParam);
    return Response.json({
      ...payload,
      payRun: arrival.payRun,
      estimatedArrival: arrival.estimatedArrival,
      effectiveArrival: arrival.effectiveArrival,
      arrivalError: arrival.arrivalError,
      arrivalOverride: arrival.override,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
