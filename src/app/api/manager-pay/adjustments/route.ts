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
// Auth: dual-mode bearer (session token OR CRON_SECRET). A session must be an admin OR hold the
// Manager pay box (can_change_manager_pay, 0260; Ryan 2026-11-07), the same people the staff app lets
// "Add someone not on the schedule".
//
// LOGGED (2026-11-07): every save and every clear goes through recordWrite into change_log, before
// and after read from the table, the verdict a re-read. It was never logged before, admins included.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { refuseUnlessPayChanger } from "@/lib/adminSession";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  const cronSecret = process.env.CRON_SECRET;
  let actor = "cron";
  if (!cronSecret || !constantTimeMatch(token, cronSecret)) {
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sessionClient.auth.getUser(token);
    if (error || !data?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
    const refusal = await refuseUnlessPayChanger(data.user.email);
    if (refusal) return refusal;
    actor = (data.user.email ?? "").toLowerCase();
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

  const clearing = amountNum === 0 && notes === null;
  const readRow = async (): Promise<Record<string, unknown>> => {
    const r = await supabase.from("manager_pay_adjustments").select("amount, notes").eq("manager_email", managerEmail).eq("week_start", weekStart).maybeSingle();
    return { row: r.data ?? null };
  };
  const cur = (await readRow()).row as { amount: number; notes: string | null } | null;
  let dbError: string | null = null;

  const { outcome, error } = await recordWrite(
    {
      env: "production", source: "Manager Pay — adjustment", actorName: actor, actorEmail: actor === "cron" ? null : actor,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: clearing ? "DELETE" : "POST", path: `/manager-pay/adjustments/${weekStart}`,
      // The facts and nothing else: week, person, amount, note. No phone.
      body: { weekStart, managerEmail, amount: amountNum, notes },
      keys: [], label: (k) => k,
      applied: (_b, a) => {
        const row = a.row as { amount: number; notes: string | null } | null;
        return clearing ? row == null : !!row && Number(row.amount) === amountNum && (row.notes ?? null) === notes;
      },
      changes: [
        { key: "amount", field: `Additional pay · ${managerEmail} · week of ${weekStart}`, before: cur ? Number(cur.amount) : 0, after: clearing ? 0 : amountNum },
        { key: "notes", field: "Note", before: cur?.notes ?? "—", after: clearing ? "—" : notes ?? "—" },
      ],
    },
    {
      readResource: readRow,
      write: async () => {
        // amount=0 with no notes → delete (keeps the table clean).
        if (clearing) {
          const { error: e } = await supabase.from("manager_pay_adjustments").delete().eq("manager_email", managerEmail).eq("week_start", weekStart);
          if (e) { dbError = `delete failed: ${e.message}`; throw Object.assign(new Error(dbError), { name: "WriteFailedError" }); }
          return { ok: true };
        }
        // Upsert by (manager_email, week_start) unique constraint.
        const { error: e } = await supabase.from("manager_pay_adjustments").upsert(
          { manager_email: managerEmail, week_start: weekStart, amount: amountNum, notes, manager_id: managerId, updated_at: new Date().toISOString() },
          { onConflict: "manager_email,week_start" },
        );
        if (e) { dbError = `upsert failed: ${e.message}`; throw Object.assign(new Error(dbError), { name: "WriteFailedError" }); }
        return { ok: true };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error) return Response.json({ error: dbError ?? error.message, outcome }, { status: 500 });
  if (clearing) return Response.json({ deleted: true });
  return Response.json({
    saved: { managerEmail, weekStart, amount: amountNum, notes },
  });
}
