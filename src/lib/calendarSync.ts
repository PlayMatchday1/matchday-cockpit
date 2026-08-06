// Google Calendar sync — a FULL window rebuild every run. For each impersonated
// account (domain-wide delegation) it lists this-window meetings, then all copies
// are resolved per (iCalUID, start_utc) and the whole mirror is replaced atomically
// (calendar_replace_window). Read-only against Google; writes only our tables.
// Node-only. The service-account key is decoded at runtime only and never logged.
//
// PRIVACY AT RETRIEVAL: the `fields` parameter never requests description or
// location, so those bytes never arrive — cannot be logged, cached, or stored. The
// schema has no column for them either.

import "server-only";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

// The ONLY fields we pull. summary (title) yes; description + location NO.
// id/recurringEventId/originalStartTime aid tracing a moved occurrence; id is the
// only key present on some minimal responses. attendeesOmitted flags a >100
// truncated attendee list so the under-2 filter isn't fooled by truncation.
export const CALENDAR_FIELDS =
  "nextPageToken,items(id,iCalUID,recurringEventId,originalStartTime(dateTime,date,timeZone)," +
  "summary,status,visibility,start(dateTime,date,timeZone),end(dateTime,date,timeZone)," +
  "organizer(email,displayName),attendeesOmitted,attendees(email,displayName,organizer,resource)," +
  "hangoutLink,conferenceData(entryPoints(entryPointType,uri,label)))";

// Dot-alias + plus-tag normalization for GOOGLE-HOSTED domains ONLY. Google ignores
// dots and +tags in the local part, so n.zelfine@ and nzelfine@ are one mailbox.
// icloud.com and other providers treat dots as significant — never touch them.
const GOOGLE_DOMAINS = new Set(["playmatchday.com", "gmail.com"]);
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  const domain = e.slice(at + 1);
  let local = e.slice(0, at);
  if (GOOGLE_DOMAINS.has(domain)) local = local.split("+")[0].replace(/\./g, "");
  return `${local}@${domain}`;
}

// UTC instant for Chicago-local midnight of an all-day date (YYYY-MM-DD). An all-day
// event has no time/offset; anchoring at UTC-midnight would push a Monday all-day
// event into Sunday's Chicago week. Anchor at Chicago 00:00 instead.
const CHI = "America/Chicago";
function chicagoOffsetMs(at: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: CHI, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const m: Record<string, string> = {};
  for (const x of p) m[x.type] = x.value;
  const hh = m.hour === "24" ? 0 : Number(m.hour);
  return Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day), hh, Number(m.minute), Number(m.second)) - at.getTime();
}
function chicagoMidnightUtcIso(dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const off1 = chicagoOffsetMs(new Date(guess));
  const cand = guess - off1;
  const off2 = chicagoOffsetMs(new Date(cand));
  return new Date(off2 === off1 ? cand : guess - off2).toISOString();
}

const WINDOW_BACK_DAYS = 7;
const WINDOW_FWD_DAYS = 21;

export class CalendarConfigError extends Error {}

type ServiceAccount = { client_email: string; private_key: string; project_id?: string; client_id?: string };

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) throw new CalendarConfigError("GOOGLE_SERVICE_ACCOUNT_JSON is not set.");
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw);
  } catch {
    try {
      sa = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      throw new CalendarConfigError("GOOGLE_SERVICE_ACCOUNT_JSON did not parse as JSON (raw or base64).");
    }
  }
  if (!sa.client_email || !sa.private_key) throw new CalendarConfigError("Service-account JSON missing client_email/private_key.");
  return sa;
}

async function delegatedToken(sa: ServiceAccount, subjectEmail: string): Promise<string> {
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [CALENDAR_SCOPE], subject: subjectEmail });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("No delegated access token returned.");
  return token;
}

type GTime = { dateTime?: string; date?: string; timeZone?: string };
type GEvent = {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: GTime;
  summary?: string;
  status?: string;
  visibility?: string;
  start?: GTime;
  end?: GTime;
  organizer?: { email?: string; displayName?: string };
  attendeesOmitted?: boolean;
  attendees?: { email?: string; displayName?: string; organizer?: boolean; resource?: boolean }[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string; label?: string }[] };
};

// Store ONLY the video entry-point URI (or hangoutLink fallback). Phone/SIP/more —
// which carry dial-in numbers + PINs — are discarded entirely. Returns the source
// so a run can report video vs hangoutLink-fallback vs neither.
function extractMeetUrl(ev: GEvent): { url: string | null; source: "conference-video" | "hangout" | "none" } {
  const video = (ev.conferenceData?.entryPoints ?? []).find((e) => e.entryPointType === "video");
  if (video?.uri) return { url: video.uri, source: "conference-video" };
  if (ev.hangoutLink) return { url: ev.hangoutLink, source: "hangout" };
  return { url: null, source: "none" };
}

function parseInstant(s?: GTime): { iso: string | null; tz: string | null; allDay: boolean } {
  if (!s) return { iso: null, tz: null, allDay: false };
  if (s.dateTime) return { iso: new Date(s.dateTime).toISOString(), tz: s.timeZone ?? null, allDay: false }; // RFC3339 offset → correct UTC
  if (s.date) return { iso: chicagoMidnightUtcIso(s.date), tz: s.timeZone ?? null, allDay: true }; // all-day anchored at Chicago 00:00
  return { iso: null, tz: null, allDay: false };
}

type Attendee = { email: string; display_name: string | null; organizer: boolean };
function humanAttendees(ev: GEvent): { count: number; rows: Attendee[] } {
  const byEmail = new Map<string, Attendee>();
  for (const a of ev.attendees ?? []) {
    if (a.resource === true || !a.email) continue; // exclude rooms/resources
    const key = normalizeEmail(a.email); // dot/plus-normalized for google domains → aliases collapse
    if (!byEmail.has(key)) byEmail.set(key, { email: key, display_name: a.displayName ?? null, organizer: !!a.organizer });
  }
  const org = ev.organizer?.email ? normalizeEmail(ev.organizer.email) : undefined;
  if (org) {
    const ex = byEmail.get(org);
    if (ex) ex.organizer = true;
    else byEmail.set(org, { email: org, display_name: ev.organizer?.displayName ?? null, organizer: true });
  }
  return { count: byEmail.size, rows: [...byEmail.values()] };
}

export type CalendarCounters = {
  accountsRequested: number;
  accountsSucceeded: number;
  accountErrors: { emailDomain: string; error: string }[];
  eventsSeen: number; // raw items across all accounts (before dedup)
  distinctOccurrences: number; // distinct (iCalUID, start_utc) after dedup
  eventsStored: number; // occurrences stored (>=2 humans, not private)
  eventsSkippedPrivate: number;
  eventsSkippedTooFewPeople: number;
  eventsSkippedCancelled: number;
  eventsDeleted: number; // occurrences present before this run, absent after (from the diff)
  attendeeDisagreements: number; // (iCalUID,start_utc) where accounts reported different human counts
  meetVideo: number; // stored meetings whose link came from a conferenceData video entry point
  meetHangout: number; // ... from the hangoutLink fallback
  meetNone: number; // ... with no video link (in-person / phone-only / Zoom / Teams)
  chicagoWeekHardcoded: true;
  sa: { clientEmailLocalPart: string; projectId: string | null };
};

// Accumulator per resolved occurrence — we keep the COPY with the most humans.
type Resolved = {
  ical_uid: string;
  start_utc: string;
  ev: GEvent;
  humans: number;
  attendees: Attendee[];
  seenCounts: Set<number>; // distinct human counts seen across accounts (disagreement detector)
  private: boolean;
  cancelled: boolean;
};

async function listAccountWindow(token: string, winMinIso: string, winMaxIso: string): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({
      singleEvents: "true",
      maxResults: "250",
      orderBy: "startTime",
      timeMin: winMinIso,
      timeMax: winMaxIso,
      fields: CALENDAR_FIELDS,
    });
    if (pageToken) p.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${p.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`events.list ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const body = (await res.json()) as { items?: GEvent[]; nextPageToken?: string };
    for (const ev of body.items ?? []) out.push(ev);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

export async function syncAllCalendars(sb: SupabaseClient, now: Date): Promise<CalendarCounters> {
  const sa = serviceAccount();
  const c: CalendarCounters = {
    accountsRequested: 0, accountsSucceeded: 0, accountErrors: [],
    eventsSeen: 0, distinctOccurrences: 0, eventsStored: 0,
    eventsSkippedPrivate: 0, eventsSkippedTooFewPeople: 0, eventsSkippedCancelled: 0,
    eventsDeleted: 0, attendeeDisagreements: 0, meetVideo: 0, meetHangout: 0, meetNone: 0, chicagoWeekHardcoded: true,
    sa: { clientEmailLocalPart: sa.client_email.split("@")[0], projectId: sa.project_id ?? null },
  };

  const { data: accounts } = await sb.from("calendar_sync_accounts").select("email").eq("active", true);
  const list = accounts ?? [];
  c.accountsRequested = list.length;

  const winMinIso = new Date(now.getTime() - WINDOW_BACK_DAYS * 86400_000).toISOString();
  const winMaxIso = new Date(now.getTime() + WINDOW_FWD_DAYS * 86400_000).toISOString();

  // Resolve every occurrence across all accounts, keeping the copy with the most
  // humans (attendee visibility differs per calendar — trap 6).
  const resolved = new Map<string, Resolved>();
  for (const acc of list) {
    const domain = acc.email.includes("@") ? acc.email.split("@")[1] : "?";
    try {
      const token = await delegatedToken(sa, acc.email);
      const items = await listAccountWindow(token, winMinIso, winMaxIso);
      for (const ev of items) {
        c.eventsSeen++;
        const s = parseInstant(ev.start);
        if (!ev.iCalUID || !s.iso) continue;
        const key = `${ev.iCalUID} ${s.iso}`;
        const cancelled = ev.status === "cancelled";
        const isPrivate = ev.visibility === "private" || ev.visibility === "confidential";
        const { count: humans, rows } = humanAttendees(ev);
        const cur = resolved.get(key);
        if (!cur) {
          resolved.set(key, {
            ical_uid: ev.iCalUID, start_utc: s.iso, ev, humans, attendees: rows,
            seenCounts: new Set([humans]), private: isPrivate, cancelled,
          });
        } else {
          cur.seenCounts.add(humans);
          if (humans > cur.humans) { cur.humans = humans; cur.attendees = rows; cur.ev = ev; } // most-humans copy wins
          cur.private = cur.private || isPrivate; // if any copy marks it private, respect that
          cur.cancelled = cur.cancelled && cancelled; // stored only if cancelled everywhere
        }
      }
      c.accountsSucceeded++;
      await sb.from("calendar_sync_accounts").update({ last_synced_at: new Date().toISOString(), last_error: null }).eq("email", acc.email);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      c.accountErrors.push({ emailDomain: domain, error: msg.slice(0, 200) });
      await sb.from("calendar_sync_accounts").update({ last_error: msg.slice(0, 300) }).eq("email", acc.email);
    }
  }

  c.distinctOccurrences = resolved.size;

  // Build the new mirror from the resolved copies, applying skips on the RESOLVED copy.
  const meetingsJson: unknown[] = [];
  const attendeesJson: unknown[] = [];
  for (const r of resolved.values()) {
    if (r.seenCounts.size > 1) c.attendeeDisagreements++;
    if (r.cancelled) { c.eventsSkippedCancelled++; continue; }
    if (r.private) { c.eventsSkippedPrivate++; continue; }
    const omitted = r.ev.attendeesOmitted === true; // >100 attendees truncated → definitely >=2
    if (!omitted && r.humans < 2) { c.eventsSkippedTooFewPeople++; continue; }
    const e = parseInstant(r.ev.end);
    const orig = parseInstant(r.ev.originalStartTime);
    const mu = extractMeetUrl(r.ev); // video uri or hangoutLink; never phone/PINs
    if (mu.source === "conference-video") c.meetVideo++;
    else if (mu.source === "hangout") c.meetHangout++;
    else c.meetNone++;
    meetingsJson.push({
      ical_uid: r.ical_uid,
      start_utc: r.start_utc,
      end_utc: e.iso,
      summary: r.ev.summary ?? null,
      start_tz: parseInstant(r.ev.start).tz,
      end_tz: e.tz,
      all_day: parseInstant(r.ev.start).allDay,
      organizer_email: r.ev.organizer?.email ? normalizeEmail(r.ev.organizer.email) : null,
      human_attendee_count: r.humans,
      recurring_event_id: r.ev.recurringEventId ?? null,
      original_start_utc: orig.iso,
      meet_url: mu.url,
      source_account: null, // not identity-bearing; we don't need which mailbox won the resolve
    });
    for (const a of r.attendees) {
      attendeesJson.push({ ical_uid: r.ical_uid, start_utc: r.start_utc, email: a.email, display_name: a.display_name, organizer: a.organizer });
    }
    c.eventsStored++;
  }

  // Success semantics (App Store lesson): no accounts, or ALL accounts failed, is a
  // FAILURE — and we must NOT replace the mirror in that case (an all-failed run
  // would wipe good data). Check BEFORE the atomic replace.
  if (c.accountsRequested === 0) throw new CalendarConfigError("No calendar_sync_accounts seeded — nothing to sync.");
  if (c.accountsSucceeded === 0) {
    throw new Error(`All ${c.accountsRequested} calendar account(s) failed — mirror left untouched. First error: ${c.accountErrors[0]?.error ?? "unknown"}`);
  }

  // Atomic full-window replace. Returns eventsDeleted (present before, absent now).
  const { data: deleted, error: rpcErr } = await sb.rpc("calendar_replace_window", {
    p_meetings: meetingsJson,
    p_attendees: attendeesJson,
  });
  if (rpcErr) throw new Error(`calendar_replace_window failed: ${rpcErr.message}`);
  c.eventsDeleted = typeof deleted === "number" ? deleted : 0;
  return c;
}
