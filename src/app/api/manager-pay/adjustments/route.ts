// POST /api/manager-pay/adjustments
//
// Upserts a manager_pay_adjustments row for the inline-editable
// "Additional Pay" column on the Match Manager Pay page. One row per
// (manager_email, week_start). amount=0 with no notes is treated as
// a delete (cleans up cleared cells so they don't accumulate).
//
// Body:
//   { managerEmail: string, weekStart: "YYYY-MM-DD",
//     amount: number, notes?: string | null, managerId?: number | null }
//
// Auth: dual-mode bearer (session token OR CRON_SECRET). Same pattern
// as the other manager-pay route.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 10;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Body = {
  managerEmail?: unknown;
  weekStart?: unknown;
  amount?: unknown;
  notes?: unknown;
  managerId?: unknown;
};

export async function POST(req: Request) {
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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !constantTimeMatch(token, cronSecret)) {
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sessionClient.auth.getUser(token);
    if (error || !data?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const managerEmail =
    typeof body.managerEmail === "string" ? body.managerEmail.trim() : "";
  const weekStart = typeof body.weekStart === "string" ? body.weekStart : "";
  const amountNum = Number(body.amount);
  const notes =
    typeof body.notes === "string" && body.notes.trim() !== ""
      ? body.notes.trim()
      : null;
  const managerId =
    typeof body.managerId === "number" && Number.isFinite(body.managerId)
      ? body.managerId
      : null;

  if (!managerEmail || !EMAIL_RX.test(managerEmail)) {
    return Response.json({ error: "Invalid managerEmail" }, { status: 400 });
  }
  if (!ISO_DATE_RX.test(weekStart)) {
    return Response.json(
      { error: "Invalid weekStart (YYYY-MM-DD)" },
      { status: 400 },
    );
  }
  if (!Number.isFinite(amountNum)) {
    return Response.json({ error: "Invalid amount" }, { status: 400 });
  }
  // Sanity guardrail — single-week adjustments shouldn't be huge.
  if (amountNum < -10000 || amountNum > 10000) {
    return Response.json(
      { error: "Amount out of range (-10000 to 10000)" },
      { status: 400 },
    );
  }

  // amount=0 with no notes → delete (keeps the table clean).
  if (amountNum === 0 && notes === null) {
    const { error } = await supabase
      .from("manager_pay_adjustments")
      .delete()
      .eq("manager_email", managerEmail)
      .eq("week_start", weekStart);
    if (error) {
      return Response.json(
        { error: `delete failed: ${error.message}` },
        { status: 500 },
      );
    }
    return Response.json({ deleted: true });
  }

  // Upsert by (manager_email, week_start) unique constraint.
  const { error } = await supabase.from("manager_pay_adjustments").upsert(
    {
      manager_email: managerEmail,
      week_start: weekStart,
      amount: amountNum,
      notes,
      manager_id: managerId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_email,week_start" },
  );
  if (error) {
    return Response.json(
      { error: `upsert failed: ${error.message}` },
      { status: 500 },
    );
  }

  return Response.json({
    saved: { managerEmail, weekStart, amount: amountNum, notes },
  });
}
