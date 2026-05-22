// GET /api/manager-pay/week?week=YYYY-MM-DD
//
// Thin wrapper around src/lib/managerPayCompute.ts. The actual pay
// rules + DB reads live in the shared lib so the /api/sync/cron
// recompute step can call the same code path and stay in sync with
// what the /managers UI shows.
//
// Auth: dual-mode bearer + anonymous.
//   - Valid bearer (session or CRON_SECRET) → admin response, manager
//     emails included in the payload.
//   - No bearer (or invalid) → public response, emails stripped.
//   - Page is genuinely public so city managers and the ops team can
//     share/bookmark week URLs.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  computeManagerPayForWeek,
  ISO_DATE_RX,
  weekdayUtc,
} from "@/lib/managerPayCompute";

export const runtime = "nodejs";
export const maxDuration = 30;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function checkAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return false;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return false;

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && constantTimeMatch(token, cronSecret)) return true;

  const sessionClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  return !error && !!data?.user;
}

export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  if (!weekParam || !ISO_DATE_RX.test(weekParam)) {
    return Response.json(
      { error: "Missing or malformed ?week=YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (weekdayUtc(weekParam) !== 1) {
    return Response.json(
      { error: "?week must be a Monday (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const isAdmin = await checkAdmin(req);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const payload = await computeManagerPayForWeek(supabase, weekParam, {
      isAdmin,
    });
    return Response.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
