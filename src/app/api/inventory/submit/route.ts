// POST /api/inventory/submit — PUBLIC, no-login endpoint backing the
// Equipment Inventory form. Writes ONE inventory_submissions row per
// submit (full history; the dashboard derives latest-per-manager on read).
//
// This is a public write endpoint, so it is guarded like one:
//   1. Honeypot — a filled hidden field means a bot; drop SILENTLY
//      (return 200 so the bot learns nothing).
//   2. Rate limit — max RATE_LIMIT_MAX submits / 10 min per client IP
//      (in-memory sliding window; see the lib note on per-instance scope).
//   3. Server-side validation — name/city/counts/needs, rejecting absurd
//      payloads. The DB also CHECK-constrains city + count bounds.
//
// HARD-GUARDED write path: the insert uses the SERVICE_ROLE key (server-
// side only, never exposed to the browser), which bypasses RLS. Anon has
// NO policies on the table (migration 0077), so this guarded route is the
// ONLY way to write — the honeypot / rate-limit / validation guards below
// cannot be bypassed, and the public/anon key can't touch the table.

import { createClient } from "@supabase/supabase-js";
import {
  validateInventorySubmission,
  isHoneypotTripped,
  checkRateLimit,
  type InventorySubmissionInput,
  type RateLimitStore,
} from "@/lib/inventory";

export const runtime = "nodejs";
export const maxDuration = 10;

// Per-instance rate-limit store. Module-level so it survives across
// requests on a warm instance.
const rateStore: RateLimitStore = new Map();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request) {
  let body: InventorySubmissionInput;
  try {
    body = (await req.json()) as InventorySubmissionInput;
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
      {
        error:
          "You've submitted a few times just now — please wait a few minutes and try again.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)),
        },
      },
    );
  }

  // 3) Validate.
  const result = validateInventorySubmission(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("[inventory:submit] Supabase env not configured");
    return Response.json({ error: "Server not configured." }, { status: 500 });
  }
  // Service-role client (server-side only) → bypasses RLS. This guarded
  // route is the sole write path; anon has no table access.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase
    .from("inventory_submissions")
    .insert(result.value);
  if (error) {
    console.error("[inventory:submit] insert failed", error);
    return Response.json(
      { error: "Couldn't save your submission. Please try again." },
      { status: 500 },
    );
  }

  console.log(
    `[inventory:submit] stored name="${result.value.name}" city=${result.value.city}`,
  );
  return Response.json({ ok: true }, { status: 200 });
}
