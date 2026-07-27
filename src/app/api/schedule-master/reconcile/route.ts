// POST /api/schedule-master/reconcile — auto-add completed matches that are
// missing on the Clubhouse schedule, as ONE-OFF dated entries (§1). A completed
// match definitively happened, so it needs no human confirmation.
//
// Auth: authenticateCrm (admin session OR CRON_SECRET) — the panel calls it on
// load; the hourly sync can call it too. Idempotent via schedule_master's
// partial UNIQUE(match_api_id) (23505 = no-op) AND a template-coverage check,
// so repeated runs never duplicate and never touch the recurring template.
//
// Guards: kill switch (schedule_settings.autoreconcile_enabled, default ON),
// 14-day lookback, and the START_RECONCILE_AFTER hard cutoff.
//
// ?dry=1 → returns exactly what it WOULD add (writes nothing).

import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCrm } from "@/lib/crmAuth";
import {
  isAutoAddEligible,
  matchLocalDateTime,
  SCHEDULE_RECONCILE_LOOKBACK_DAYS,
  SCHEDULE_RECONCILE_START,
} from "@/lib/scheduleReconcile";
import { buildOneOffRow, loadVenueMaps } from "@/lib/scheduleReconcileServer";

export const runtime = "nodejs";
export const maxDuration = 30;

// Minutes-since-midnight bucket key so a candidate match and a template slot on
// the same field/date/time collide (→ already covered, don't add).
function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function parseStartHHMM(time: string): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  else if (ap === "AM" && h === 12) h = 0;
  else if (!ap && h >= 5 && h <= 11) h += 12; // bare evening hour → PM
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

type MatchRow = {
  api_id: number;
  field_id: number | null;
  field_title: string | null;
  start_date: string | null;
  end_date_utc: string | null;
  is_cancelled: boolean | null;
  player_count: number | null;
  min_player_count: number | null;
  max_player_count: number | null;
  star_rating_count: number | null;
  city_identifier: string | null;
  city_name: string | null;
  raw: { field?: { city?: { name?: string | null } | null } | null } | null;
};

// Heartbeat + the current auto-added list — what §4's quiet "N auto-added"
// line and last_success_at indicator render from. Read-only.
async function loadPanelExtras(supabase: SupabaseClient, sinceDate: string) {
  const [sRes, aRes] = await Promise.all([
    supabase
      .from("schedule_settings")
      .select("autoreconcile_enabled, last_attempted_at, last_success_at, last_status, last_error")
      .eq("id", 1)
      .maybeSingle(),
    supabase
      .from("schedule_master")
      .select("id, match_api_id, city, venue, detail, match_date, match_time")
      .eq("source", "auto_completed")
      .gte("match_date", sinceDate)
      .order("match_date", { ascending: false }),
  ]);
  return { heartbeat: sRes.data ?? null, autoAdded: aRes.data ?? [] };
}

// GET — read-only panel refresh (heartbeat + auto-added list) with no writes,
// used after an Undo so the list re-renders without re-running the job.
export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sinceDate = new Date(Date.now() - SCHEDULE_RECONCILE_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const extras = await loadPanelExtras(auth.supabase, sinceDate);
  return Response.json(extras, { status: 200 });
}

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const dry = new URL(req.url).searchParams.get("dry") != null;

  const nowMs = Date.now();
  const cutoffMs = Date.parse(SCHEDULE_RECONCILE_START);
  const sinceIso = new Date(nowMs - SCHEDULE_RECONCILE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const untilIso = new Date(nowMs).toISOString();

  if (!dry) {
    await supabase
      .from("schedule_settings")
      .update({ last_attempted_at: untilIso, updated_at: untilIso })
      .eq("id", 1);
  }

  try {
    // Kill switch.
    const settings = await supabase
      .from("schedule_settings")
      .select("autoreconcile_enabled")
      .eq("id", 1)
      .maybeSingle();
    const enabled = settings.data?.autoreconcile_enabled !== false;

    // Venue maps: field_id → fin_venue_id → venue_name.
    const maps = await loadVenueMaps(supabase);
    const { fieldToVenueId } = maps;

    // Past matches in the lookback window.
    const mRes = await supabase
      .from("mdapi_matches")
      .select(
        "api_id, field_id, field_title, start_date, end_date_utc, is_cancelled, player_count, min_player_count, max_player_count, star_rating_count, city_identifier, city_name, raw",
      )
      .is("deleted_at", null)
      .gte("end_date_utc", sinceIso)
      .lte("end_date_utc", untilIso);
    if (mRes.error) throw new Error(mRes.error.message);
    const matches = (mRes.data ?? []) as MatchRow[];

    // Existing schedule_master coverage: linked api_ids + template buckets.
    const smRes = await supabase
      .from("schedule_master")
      .select("match_api_id, mdapi_field_id, match_date, match_time");
    if (smRes.error) throw new Error(smRes.error.message);
    const linkedApiIds = new Set<number>();
    const templateBuckets = new Set<string>(); // `${fin_venue_id}|${date}|${hhmm}`
    for (const r of smRes.data ?? []) {
      if (r.match_api_id != null) linkedApiIds.add(r.match_api_id as number);
      const vid = r.mdapi_field_id != null ? fieldToVenueId.get(r.mdapi_field_id as number) : undefined;
      if (vid != null) {
        templateBuckets.add(`${vid}|${r.match_date}|${parseStartHHMM(r.match_time as string)}`);
      }
    }

    const toAdd = [];
    for (const m of matches) {
      if (linkedApiIds.has(m.api_id)) continue; // already added (idempotent)
      if (!isAutoAddEligible(m, { nowMs, cutoffMs, lookbackDays: SCHEDULE_RECONCILE_LOOKBACK_DAYS })) {
        continue; // not a completed-in-window match
      }
      const local = matchLocalDateTime(m.start_date);
      if (!local) continue;
      const vid = m.field_id != null ? fieldToVenueId.get(m.field_id) : undefined;
      const bucketHHMM = hhmm(m.start_date) ?? "";
      // Already covered by a recurring template slot on the same field/date/time?
      if (vid != null && templateBuckets.has(`${vid}|${local.date}|${bucketHHMM}`)) continue;

      const row = buildOneOffRow(m, maps, "auto_completed");
      if (row) toAdd.push(row);
    }

    const sinceDate = sinceIso.slice(0, 10);

    // Dry-run: report, write nothing.
    if (dry) {
      const extras = await loadPanelExtras(supabase, sinceDate);
      return Response.json(
        {
          dryRun: true,
          autoreconcileEnabled: enabled,
          cutoff: SCHEDULE_RECONCILE_START,
          lookbackDays: SCHEDULE_RECONCILE_LOOKBACK_DAYS,
          candidateCount: toAdd.length,
          wouldAdd: toAdd,
          ...extras,
        },
        { status: 200 },
      );
    }

    if (!enabled) {
      await supabase
        .from("schedule_settings")
        .update({ last_success_at: untilIso, last_status: "200", last_error: null, updated_at: untilIso })
        .eq("id", 1);
      const extras = await loadPanelExtras(supabase, sinceDate);
      return Response.json(
        { ok: true, autoreconcileEnabled: false, added: 0, wouldHaveAdded: toAdd.length, ...extras },
        { status: 200 },
      );
    }

    // Real run — insert one-offs, idempotent on the partial unique index.
    let added = 0;
    let already = 0;
    for (const row of toAdd) {
      const ins = await supabase.from("schedule_master").insert(row).select("id").maybeSingle();
      if (ins.error) {
        if (ins.error.code === "23505") already++;
        else console.error(`[schedule:reconcile] insert failed match=${row.match_api_id}`, ins.error);
      } else {
        added++;
      }
    }

    await supabase
      .from("schedule_settings")
      .update({ last_success_at: untilIso, last_status: "200", last_error: null, updated_at: untilIso })
      .eq("id", 1);
    console.log(`[schedule:reconcile] added=${added} already=${already} considered=${toAdd.length}`);
    const extras = await loadPanelExtras(supabase, sinceDate);
    return Response.json(
      { ok: true, autoreconcileEnabled: true, added, alreadyPresent: already, ...extras },
      { status: 200 },
    );
  } catch (err) {
    console.error("[schedule:reconcile] run failed", err);
    if (!dry) {
      await supabase
        .from("schedule_settings")
        .update({ last_status: "500", last_error: err instanceof Error ? err.message : String(err), updated_at: untilIso })
        .eq("id", 1);
    }
    return Response.json({ error: "Reconcile failed" }, { status: 500 });
  }
}
