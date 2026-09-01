// Server-side assembly of the Veo coverage week: current-week matches from the
// mdapi mirror, joined to Clubhouse veo_intent (the toggleable camera mark) and
// veo_camera_count (the editable per-city inventory), with veo_codes carried along
// as read-only reference. The match name is stripped of the camera emoji here so no
// surface downstream renders the raw glyph. Read-only mdapi; writes go to the two
// Clubhouse tables only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName } from "./venueResolver";
import { hasCameraEmoji, stripCameraEmoji } from "./veo";

// mdapi start_date is venue-local wall-clock stamped at +00:00 — read the parts as
// local, ignore the offset (same rule the Slate schedule uses).
const local = (s: string) => new Date(s.replace(/([+-]\d\d:\d\d|Z)$/, ""));
function fmtTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Monday (index 0) of the week containing `now`, as a local Date. */
export function weekMonday(now: Date): Date {
  const day = now.getDay(); // 0=Sun..6=Sat
  const back = (day + 6) % 7; // days since Monday
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

export type VeoMatch = {
  apiId: number;
  city: string;
  dayIdx: number; // 0=Mon..6=Sun
  time: string; // "6:30 PM"
  minutes: number; // sort key
  venue: string; // canonical venue (canonicalVenueName rules)
  // THE RAW field_title, UNTOUCHED. `venue` above is canonicalised by canonicalVenueName;
  // cancelPatterns canonicalises through normalizeMatchName + the fin_venues aliases, which is a
  // DIFFERENT pipeline. Anything that has to line a match up against a cancel slot must run both
  // sides through ONE of them, so the raw string travels and the consumer decides. Free: field_title
  // is already in the select.
  fieldRaw: string;
  name: string; // emoji-stripped display name
  // THE RAW NAME, exactly as MatchDay holds it. The stripped one above is for display and cannot
  // drive a write: the name sync has to diff against what is actually stored, and it has to be
  // able to say "no change". Carried here rather than re-fetched per toggle — it is one more
  // string on a row already being selected, and the alternative is a GET per chip.
  rawName: string;
  veo: boolean; // Clubhouse intent (veo_intent.enabled)
  hasEmoji: boolean; // 🎥 present in the raw MatchDay name
};

export type VeoWeek = {
  weekStart: string; // Monday YYYY-MM-DD
  days: { dow: string; date: number; iso: string; today: boolean }[];
  cities: { city: string; cameras: number }[];
  matches: VeoMatch[];
  codesRef: { city: string; codes: { code: string; confirmed: boolean }[] }[];
  seededThisWeek: number; // matches this week whose intent came from the emoji seed
  generatedAt: string;     // when this response was assembled — NOT a freshness claim
  /** max(synced_at) over the week's rows: how old the DATA is. Null when the week is empty. */
  dataAsOf: string | null;
};

// `now` is the real clock (drives the per-day "today" flag + generatedAt);
// `weekRef` selects WHICH week to assemble (any date within it). They are separate
// so navigating to another week never marks one of its days as "today".
/**
 * @param scopeCity a confined caller's city_identifier ("WAW"), or null for an unconfined caller.
 *   THE FILTER IS IN THE QUERY, not applied to the result, so a confined caller's rows never leave
 *   the database. It comes from app_users via the route — never from a query param.
 */
/* INCLUDE CANCELLED — for callers that need the SLATE rather than the play.
 *
 * Match Promotion's NEW-match rule compares this week against the prior week's SLATE, and a
 * cancelled match was still on it: scheduled, published, copied forward by copy-week, and seen by
 * players. Measured 2026-08-25, treating a cancelled slot as "did not run" flagged 31 of 109
 * matches as new and 21 of those were slots that had existed the week before and been cancelled —
 * Bicentennial Park reading as a NEW FIELD in Dallas being the clearest.
 *
 * IT IS A PARAMETER RATHER THAN A SECOND QUERY because this function owns the wall-clock parse,
 * the fleet-city filter and the deleted-row exclusion. A separate prior-week fetch would be a
 * second place for the wall-clock trap to be got wrong, which is the thing this module exists to
 * prevent. Default false: every existing caller keeps play-only semantics. */
export async function fetchVeoWeek(sb: SupabaseClient, now: Date, weekRef: Date = now, scopeCity: string | null = null, includeCancelled = false): Promise<VeoWeek> {
  const mon = weekMonday(weekRef);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const todayIso = ymd(now);
  const days = DOW.map((dow, i) => {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    return { dow, date: d.getDate(), iso: ymd(d), today: ymd(d) === todayIso };
  });

  // live, non-cancelled matches this week
  let q = sb
    .from("mdapi_matches")
    /* synced_at IS SELECTED FOR THE FRESHNESS STAMP. The page used to stamp "Updated 1:04 PM"
     * from the moment it READ the mirror, which says when the query ran and nothing at all about
     * how old the data is. max(synced_at) is the data's own age — the cron's write, or a
     * write-through, whichever touched a row last. */
    .select("api_id, name, city_identifier, field_title, start_date, is_cancelled, deleted_at, synced_at")
    .is("deleted_at", null)
    .gte("start_date", ymd(mon))
    .lte("start_date", `${ymd(sun)}T23:59:59`);
  /* THE BOUNDARY, IN SQL, AND ONLY WHEN THERE IS ONE. A confined caller cannot receive another
   * city's matches even if the display map or a client filter later changes.
   *
   * APPLIED ONLY WHEN scopeCity IS SET. Writing this as one chained filter with a `not.is null`
   * branch for the unconfined case would ALSO have dropped every match with a null
   * city_identifier — a silent behaviour change for every existing user, to serve a boundary that
   * does not apply to them. */
  if (scopeCity) q = q.eq("city_identifier", scopeCity);
  const { data: rows, error } = await q;
  if (error) throw new Error(`veo matches: ${error.message}`);
  const live = (rows ?? []).filter((r) => (includeCancelled || !r.is_cancelled) && r.start_date);

  // intent for this week's matches
  const ids = live.map((r) => r.api_id);
  const intent = new Map<number, { enabled: boolean; seeded: boolean }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { data: vi } = await sb.from("veo_intent").select("match_api_id, enabled, set_by").in("match_api_id", chunk);
    for (const r of vi ?? []) intent.set(r.match_api_id, { enabled: !!r.enabled, seeded: r.set_by === "seed:emoji" });
  }

  const monTime = mon.getTime();
  const matches: VeoMatch[] = [];
  let seededThisWeek = 0;
  for (const r of live) {
    const city = CITY_CODE_TO_DISPLAY[r.city_identifier ?? ""] ?? null;
    if (!city) continue; // only fleet cities appear in the grid
    const d = local(r.start_date as string);
    const dayIdx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - monTime) / 86400000);
    if (dayIdx < 0 || dayIdx > 6) continue;
    const rec = intent.get(r.api_id);
    if (rec?.seeded && rec.enabled) seededThisWeek++;
    matches.push({
      apiId: r.api_id,
      city,
      dayIdx,
      time: fmtTime(d),
      minutes: d.getHours() * 60 + d.getMinutes(),
      venue: canonicalVenueName(r.field_title ?? "") || (r.field_title ?? "Unknown"),
      fieldRaw: (r.field_title as string) ?? "",
      name: stripCameraEmoji(r.name),
      rawName: (r.name as string) ?? "",
      veo: rec?.enabled ?? false,
      hasEmoji: hasCameraEmoji(r.name),
    });
  }

  const { data: cams } = await sb.from("veo_camera_count").select("city, cameras").order("city");
  const { data: codes } = await sb.from("veo_codes").select("city, code, confirmed").order("city");
  const codesByCity = new Map<string, { code: string; confirmed: boolean }[]>();
  for (const c of codes ?? []) (codesByCity.get(c.city) ?? codesByCity.set(c.city, []).get(c.city)!).push({ code: c.code, confirmed: c.confirmed });

  /* THE CITY LIST AND THE CODE REFERENCE ARE SCOPED TOO. The grid and the Schedule view both
   * iterate `cities`, so leaving it unfiltered would show a confined account seven other city
   * headings with no matches under them — and the codes reference is fleet data. */
  const scopeName = scopeCity ? (CITY_CODE_TO_DISPLAY[scopeCity] ?? null) : null;
  const keep = (city: string) => !scopeName || city === scopeName;

  return {
    weekStart: ymd(mon),
    days,
    cities: (cams ?? []).filter((c) => keep(c.city)).map((c) => ({ city: c.city, cameras: c.cameras })),
    matches,
    codesRef: [...codesByCity.entries()].filter(([city]) => keep(city)).map(([city, codes]) => ({ city, codes })),
    seededThisWeek,
    generatedAt: now.toISOString(),
    /* THE HONEST STAMP. A week with no matches has no freshness to report — null, so the page
     * says "no data" rather than inventing a time. */
    dataAsOf: (rows ?? []).reduce<string | null>(
      (acc, r) => { const v = (r as { synced_at?: string | null }).synced_at ?? null; return v && (!acc || v > acc) ? v : acc; },
      null,
    ),
  };
}
