// GET /api/calendar/week — this week's meetings for the CALLING user. Session-authed
// ONLY (Bearer user session; getUser-validated, 401 if invalid — NO cron mode).
//
// The calendar_* tables are service-role-only (REVOKE from anon/authenticated), so
// the browser client cannot read them; this route reads with the SERVICE ROLE on
// the caller's behalf. The caller's Google email = their session email (lowercased);
// we only ever return meetings they are already an attendee of, plus their own
// email — nothing about anyone else's calendar is exposed.
//
// "This week" = Monday 00:00 → next Monday 00:00 in America/Chicago, converted to
// UTC instants (DST-correct — the offset is resolved from the zone, never a naive
// local compare).

import { createClient } from "@supabase/supabase-js";
import { normalizeEmail } from "@/lib/calendarSync";

export const runtime = "nodejs";
export const maxDuration = 30;
// Never statically cache — "this week" + the caller's identity must be evaluated
// per request (item 4a: a cached response would pin state to build time).
export const dynamic = "force-dynamic";

// Offset (localWallClock - utc) in ms for a zone at a given instant.
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - at.getTime();
}

// UTC instant (ms) for a wall-clock date/time in `timeZone`. Two-pass to resolve
// the correct offset across DST transitions.
function zonedWallToUtcMs(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, m, d, hh, mm, ss);
  const off1 = zoneOffsetMs(timeZone, new Date(guess));
  const candidate = guess - off1;
  const off2 = zoneOffsetMs(timeZone, new Date(candidate));
  return off2 === off1 ? candidate : guess - off2;
}

// Monday 00:00 (inclusive) → next Monday 00:00 (exclusive) of the Chicago week that
// contains `now`, returned as UTC instants.
function chicagoWeekBounds(now: Date): { startMs: number; endMs: number } {
  const TZ = "America/Chicago";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const dowIndex: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = dowIndex[map.weekday] ?? 0;

  // Chicago-local calendar date of "today", then back up to Monday.
  const monday = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
  monday.setUTCDate(monday.getUTCDate() - dow);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);

  const startMs = zonedWallToUtcMs(
    monday.getUTCFullYear(),
    monday.getUTCMonth(),
    monday.getUTCDate(),
    0,
    0,
    0,
    TZ,
  );
  const endMs = zonedWallToUtcMs(
    nextMonday.getUTCFullYear(),
    nextMonday.getUTCMonth(),
    nextMonday.getUTCDate(),
    0,
    0,
    0,
    TZ,
  );
  return { startMs, endMs };
}

type AttendeeRow = { ical_uid: string; start_utc: string; email: string; display_name: string | null; organizer: boolean };

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey || !publishableKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }

  // Session-only auth — validate the caller and derive their Google email. No cron
  // mode. The privileged read runs with the service role (tables are
  // service-role-only), but the session is a hard AUTHN gate.
  const sessionClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sessionClient.auth.getUser(token);
  if (userErr || !userData?.user?.email) {
    return Response.json({ error: "Invalid session" }, { status: 401 });
  }
  // Normalize the SAME way stored attendee emails are (dot/plus for google domains),
  // so an alias variant of the caller still matches their meetings (item 2).
  const callerEmail = normalizeEmail(userData.user.email);

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Name-resolution ladder (item 5). app_users keyed by NORMALIZED email is rung 1.
  const { data: appUsers } = await supabase.from("app_users").select("email, full_name");
  const nameByEmail = new Map<string, string>();
  for (const u of (appUsers ?? []) as { email: string; full_name: string | null }[]) {
    const n = (u.full_name ?? "").trim();
    if (n) nameByEmail.set(normalizeEmail(u.email), n);
  }
  // rung 3: prettify a @playmatchday.com local part (first-initial + surname → "R. Mancuso").
  function prettifyPlaymatchday(local: string): string {
    if (local.length < 2) return local.charAt(0).toUpperCase() + local.slice(1);
    return `${local[0].toUpperCase()}. ${local[1].toUpperCase()}${local.slice(2)}`;
  }
  // Returns { name, rung } — stop at first hit. NEVER derive names for external addresses.
  function resolveName(email: string, googleName: string | null): { name: string; rung: 1 | 2 | 3 | 4 } {
    const u = nameByEmail.get(email);
    if (u) return { name: u, rung: 1 };
    const g = (googleName ?? "").trim();
    if (g) return { name: g, rung: 2 };
    const at = email.lastIndexOf("@");
    if (at > 0 && email.slice(at + 1) === "playmatchday.com") return { name: prettifyPlaymatchday(email.slice(0, at)), rung: 3 };
    return { name: email, rung: 4 };
  }

  const grantConfigured = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  // syncHasRun: at least one COMPLETED, error-free google-calendar log row exists.
  // A query ERROR must NOT masquerade as "sync hasn't run" — surface it (500).
  const { data: syncRow, error: syncErr } = await supabase
    .from("fin_sync_log")
    .select("id")
    .eq("source", "google-calendar")
    .not("completed_at", "is", null)
    .is("error_message", null)
    .limit(1);
  if (syncErr) return Response.json({ error: `calendar read failed: ${syncErr.message}` }, { status: 500 });
  const syncHasRun = (syncRow?.length ?? 0) > 0;

  const { startMs, endMs } = chicagoWeekBounds(new Date());
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const pairKey = (u: string, s: string) => `${u} ${new Date(s).toISOString()}`;

  // The caller's OWN occurrences this week. Attendees carry start_utc, so we window
  // and match per (ical_uid, start_utc) — not just ical_uid — so a recurring series
  // shows the right instances and only the ones the caller is actually on.
  const { data: myPairs, error: pairsErr } = await supabase
    .from("calendar_meeting_attendees")
    .select("ical_uid, start_utc")
    .eq("email", callerEmail)
    .gte("start_utc", startIso)
    .lt("start_utc", endIso);
  // A DB error here is NOT "no meetings" — surface it so the card shows an error,
  // not a false-empty (the recurring hazard).
  if (pairsErr) return Response.json({ error: `calendar read failed: ${pairsErr.message}` }, { status: 500 });
  const pairs = (myPairs ?? []) as { ical_uid: string; start_utc: string }[];
  if (pairs.length === 0) {
    // Empty state — the caller has no meetings this week, not an error.
    return Response.json({ grantConfigured, syncHasRun, userEmail: callerEmail, meetings: [] }, { status: 200 });
  }
  const wanted = new Set(pairs.map((p) => pairKey(p.ical_uid, p.start_utc)));
  const uids = [...new Set(pairs.map((p) => p.ical_uid))];

  const { data: meetingRows, error: meErr } = await supabase
    .from("calendar_meetings")
    .select("ical_uid, start_utc, summary, end_utc, start_tz, all_day, meet_url")
    .in("ical_uid", uids)
    .gte("start_utc", startIso)
    .lt("start_utc", endIso)
    .order("start_utc", { ascending: true });
  if (meErr) return Response.json({ error: `calendar read failed: ${meErr.message}` }, { status: 500 });
  const meetings = (meetingRows ?? []).filter((m) => wanted.has(pairKey(m.ical_uid as string, m.start_utc as string)));

  // Attendees for exactly those occurrences, grouped by (ical_uid, start_utc).
  const attByKey = new Map<string, { email: string; display_name: string | null; organizer: boolean }[]>();
  if (meetings.length > 0) {
    const { data: attRows } = await supabase
      .from("calendar_meeting_attendees")
      .select("ical_uid, start_utc, email, display_name, organizer")
      .in("ical_uid", uids)
      .gte("start_utc", startIso)
      .lt("start_utc", endIso);
    for (const a of (attRows ?? []) as AttendeeRow[]) {
      const k = pairKey(a.ical_uid, a.start_utc);
      if (!wanted.has(k)) continue;
      const cur = attByKey.get(k) ?? [];
      cur.push({ email: a.email, display_name: a.display_name, organizer: a.organizer });
      attByKey.set(k, cur);
    }
  }

  return Response.json(
    {
      grantConfigured,
      syncHasRun,
      userEmail: callerEmail,
      meetings: meetings.map((m) => ({
        ical_uid: m.ical_uid,
        summary: m.summary,
        start_utc: m.start_utc,
        end_utc: m.end_utc,
        start_tz: m.start_tz,
        all_day: m.all_day,
        meet_url: (m as { meet_url?: string | null }).meet_url ?? null,
        attendees: (attByKey.get(pairKey(m.ical_uid as string, m.start_utc as string)) ?? []).map((a) => ({
          email: a.email,
          name: resolveName(a.email, a.display_name).name,
          organizer: a.organizer,
          self: a.email === callerEmail,
        })),
      })),
    },
    { status: 200 },
  );
}
