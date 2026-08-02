// POST /api/schedule-master/copy-week — build a week's plan by copying the prior
// week's recurring template forward. Each previous-week template row is recreated
// on the same day-of-week in the target week (prev date + 7), skipping any slot
// that already exists (same field/venue + date + time). This is the "copy button
// to create in master schedule" for planning future weeks; it writes ONLY to
// schedule_master (never to any mdapi_* table) and is admin-gated + audited.

import { authenticateCrm } from "@/lib/crmAuth";
import { writeScheduleMasterAudit, type ScheduleMasterRow } from "@/lib/scheduleMaster";

export const runtime = "nodejs";
export const maxDuration = 15;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Normalise a time string for dedup — same shape both sides ("7:00 PM - ..." vs
// "7 PM"): first token's minutes since midnight.
function timeKey(t: string): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(t);
  if (!m) return t.trim().toLowerCase();
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${h * 60 + min}`;
}
const slotKey = (fieldId: number | null, venue: string, date: string, time: string) =>
  `${fieldId ?? `v:${venue.toLowerCase()}`}|${date}|${timeKey(time)}`;

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.email) return Response.json({ error: "Operator session required" }, { status: 403 });
  const { supabase, email } = auth;

  let body: { week_start?: unknown };
  try { body = (await req.json()) as { week_start?: unknown }; }
  catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
  const weekStart = typeof body.week_start === "string" ? body.week_start : "";
  if (!ISO.test(weekStart)) return Response.json({ error: "week_start must be YYYY-MM-DD" }, { status: 400 });

  const prevStart = addDaysIso(weekStart, -7);
  const prevEnd = addDaysIso(weekStart, -1);
  const weekEnd = addDaysIso(weekStart, 6);

  // Prior week's recurring template rows are the source; one-offs (manual /
  // auto_completed) are actuals, not a plan to repeat.
  const prevRes = await supabase
    .from("schedule_master")
    .select("city, venue, detail, match_date, match_time, max_spots, mdapi_field_id, source")
    .gte("match_date", prevStart)
    .lte("match_date", prevEnd)
    .eq("source", "template");
  if (prevRes.error) return Response.json({ error: "DB error reading prior week" }, { status: 500 });
  const prevRows = (prevRes.data ?? []) as Array<{
    city: string; venue: string; detail: string; match_date: string;
    match_time: string; max_spots: number; mdapi_field_id: number | null; source: string;
  }>;

  // Existing target-week slots → dedup set.
  const curRes = await supabase
    .from("schedule_master")
    .select("venue, match_date, match_time, mdapi_field_id")
    .gte("match_date", weekStart)
    .lte("match_date", weekEnd);
  if (curRes.error) return Response.json({ error: "DB error reading target week" }, { status: 500 });
  const existing = new Set(
    (curRes.data ?? []).map((r) => slotKey(r.mdapi_field_id as number | null, r.venue as string, r.match_date as string, r.match_time as string)),
  );

  const toInsert: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const r of prevRows) {
    const targetDate = addDaysIso(r.match_date, 7);
    if (targetDate < weekStart || targetDate > weekEnd) continue; // safety
    const k = slotKey(r.mdapi_field_id, r.venue, targetDate, r.match_time);
    if (existing.has(k)) { skipped++; continue; }
    existing.add(k); // guard against duplicate prev rows collapsing onto one slot
    toInsert.push({
      city: r.city, venue: r.venue, detail: r.detail, match_date: targetDate,
      match_time: r.match_time, max_spots: r.max_spots, mdapi_field_id: r.mdapi_field_id,
      source: "template",
    });
  }

  if (toInsert.length === 0) return Response.json({ ok: true, added: 0, skipped });

  const ins = await supabase
    .from("schedule_master")
    .insert(toInsert)
    .select("id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id, source");
  if (ins.error) {
    console.error("[schedule-master:copy-week] insert failed", ins.error);
    return Response.json({ error: "Insert failed" }, { status: 500 });
  }
  const inserted = (ins.data ?? []) as ScheduleMasterRow[];
  for (const row of inserted) {
    await writeScheduleMasterAudit(supabase, {
      action: "create", userEmail: email, rowId: row.id, oldValues: null, newValues: row,
    });
  }

  return Response.json({ ok: true, added: inserted.length, skipped });
}
