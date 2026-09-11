// POST /api/city-check-ins/submit — PUBLIC, no-login endpoint backing the City Manager Check-In
// form. Writes ONE city_manager_check_ins row per submit (full history; the Check-Ins dashboard
// derives latest-per-city on read, the way Equipment derives latest-per-manager).
//
// This is a public write endpoint, so it is guarded like one — the same three guards, in the same
// order, as /api/inventory/submit:
//   1. Honeypot — a filled hidden field means a bot; drop SILENTLY (return 200 so the bot learns
//      nothing about why it failed).
//   2. Rate limit — RATE_LIMIT_MAX submits / 10 min per client IP (in-memory sliding window; see
//      the lib note on per-instance scope).
//   3. Server-side validation — a city from the cityScope allowlist, a real calendar month-ending
//      date, a 1-5 rating, and length caps. The DB CHECK-constrains all of it too.
//
// THE FORM NO LONGER ASKS FOR A NAME. manager_name is resolved from MANAGERS by city AFTER
// validation and stamped on the row as an audit field — it is never taken from the request body.
//
// HARD-GUARDED write path: the insert uses the SERVICE_ROLE key (server-side only, never exposed
// to the browser), which bypasses RLS. Anon has NO policies on the table (migration 0167), so this
// guarded route is the ONLY way to write — the guards below cannot be bypassed, and the public/anon
// key cannot touch the table at all.
//
// WHY NOT authenticateMatchOpsRead OR ANY OTHER AUTH: Ryan — "I want it to be open its not
// sensitive and not all city managers have the checkin". Some of the people who file this have no
// Clubhouse account. Nothing here reads app_users or personalises anything.

import { createClient } from "@supabase/supabase-js";
import {
  validateCityCheckIn,
  managerNameForCity,
  isHoneypotTripped,
  checkRateLimit,
  type CityCheckInInput,
  type RateLimitStore,
} from "@/lib/cityCheckIns";

export const runtime = "nodejs";
export const maxDuration = 10;

// Per-instance rate-limit store. Module-level so it survives across requests on a warm instance,
// and separate from /api/inventory/submit's store so one public form cannot rate-limit the other.
const rateStore: RateLimitStore = new Map();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request) {
  let body: CityCheckInInput;
  try {
    body = (await req.json()) as CityCheckInInput;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // 1) Honeypot — pretend success, write nothing.
  if (isHoneypotTripped(body)) {
    return Response.json({ ok: true }, { status: 200 });
  }

  // 2) Rate limit by IP.
  const ip = clientIp(req);
  const limit = checkRateLimit(ip, rateStore, Date.now());
  if (!limit.allowed) {
    return Response.json(
      { error: "You've submitted a few times just now — please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  // 3) Validate.
  const result = validateCityCheckIn(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("[city-check-ins:submit] Supabase env not configured");
    return Response.json({ error: "Server not configured." }, { status: 500 });
  }
  // Service-role client (server-side only) → bypasses RLS. This guarded route is the sole write
  // path; anon has no table access.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* THE NAME IS STAMPED HERE, FROM THE CITY — the form does not ask and cannot set it. It is an
   * audit field now, not an answer: the dashboard titles every card from MANAGERS[].name keyed on
   * cityId, which is why asking was pointless (Ryan filed as "Ryan Mancuso" for Austin and got
   * "Garrett Suits"). NULL for a city with no manager on file, which Warsaw is today — that city
   * must still be able to file. Migration 0169 made the column nullable for exactly this. */
  const row = {
    ...result.value,
    manager_name: managerNameForCity(result.value.city_identifier),
  };
  const { error } = await supabase.from("city_manager_check_ins").insert(row);
  if (error) {
    console.error("[city-check-ins:submit] insert failed", error);
    return Response.json(
      { error: "Couldn't save your check-in. Please try again." },
      { status: 500 },
    );
  }

  /* NO ANSWER BODIES IN THE LOG. The city and the month are enough to trace a submission; the
   * free-text answers are the manager's own words about their city and do not belong in a log
   * line with different access rules from the table. Same rule the change_log follows for message
   * bodies. */
  console.log(
    `[city-check-ins:submit] stored city=${row.city_identifier} month=${row.month_ending} manager=${row.manager_name ?? "(none on file)"}`,
  );
  return Response.json({ ok: true }, { status: 200 });
}
