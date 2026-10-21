// CLAUDE DRAFTS — the clock and the schedule (2026-10-21).
//
// WHY THIS EXISTS. A player asked at 3:38 PM about "2 games today at PRUMC". The draft written 16
// hours later said "let me check the schedule for PRUMC tonight": the model had no idea what time it
// was, when the player wrote, or what had already been played. This module gives it all three:
//   - the clock, in the player's city time zone (Central when unknown)
//   - how long ago the player wrote, and whether the reply is late (over 2 hours)
//   - the real matches at the field they named (or in their city) from the day they wrote, 7 days on
// and the guards that hold the draft to them: no match time that isn't in the schedule, an apology
// opening a late reply and not a timely one.
//
// TWO TIME MODELS, kept apart (CLAUDE.md "Traps"): a message's sent_at and a match's
// start_date_utc are TRUE INSTANTS, formatted in a real time zone. A match's start_date is LOCAL WALL
// CLOCK wearing a "Z": it is displayed with timeZone "UTC" so it prints as written, and day windows
// are compared against it as wall clock (the pattern loadPlayed2026Count uses).

import { timezoneFor } from "@/lib/cityTimezones";
import { resolveCityScope } from "@/lib/cityScope";

export const FALLBACK_TZ = "America/Chicago";
export const LATE_REPLY_MS = 2 * 3600e3;
const SCHEDULE_DAYS = 7;
const SCHEDULE_LIMIT = 30;

const TZ_LABEL: Record<string, string> = {
  "America/Chicago": "Central time",
  "America/New_York": "Eastern time",
  "America/Denver": "Mountain time",
  "Europe/Warsaw": "Warsaw time",
};

export function tzForCity(cityCode: string | null | undefined): string | null {
  return timezoneFor(resolveCityScope(cityCode)?.identifier ?? null);
}

const fmt = (ms: number, timeZone: string, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString("en-US", { timeZone, ...o });
export const clockTime = (ms: number, tz: string) => fmt(ms, tz, { hour: "numeric", minute: "2-digit" });
export const dayAndTime = (ms: number, tz: string) => fmt(ms, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function localYmd(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
const addDaysYmd = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400e3);

// "16h ago, yesterday 3:38 PM" / "25 min ago, today 7:13 AM" / "3 days ago, Sat Oct 17 2:10 PM".
export function sinceText(thenMs: number, nowMs: number, tz: string): string {
  const mins = Math.max(0, Math.round((nowMs - thenMs) / 60e3));
  const ago = mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)} days ago`;
  const days = dayDiff(localYmd(nowMs, tz), localYmd(thenMs, tz));
  const when = days === 0 ? `today ${clockTime(thenMs, tz)}` : days === 1 ? `yesterday ${clockTime(thenMs, tz)}` : dayAndTime(thenMs, tz);
  return `${ago}, ${when}`;
}

export type DraftClock = {
  now_local: string;
  /** "today: Wednesday, Oct 21", "yesterday: Tuesday, Oct 20", then the 5 days before, so "Monday
   *  night" resolves to a date without the model doing calendar arithmetic. */
  recent_days: string[];
  time_zone: string;
  latest_player_message: string;
  hours_since_player_message: number;
  reply_is_late: boolean;
};

export function buildClock(args: { now: number; tz: string; latestPlayerMsgIso: string }): DraftClock {
  const then = Date.parse(args.latestPlayerMsgIso);
  return {
    now_local: fmt(args.now, args.tz, { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
    recent_days: Array.from({ length: 7 }, (_, i) => {
      const label = fmt(args.now - i * 86400e3, args.tz, { weekday: "long", month: "short", day: "numeric" });
      return i === 0 ? `today: ${label}` : i === 1 ? `yesterday: ${label}` : label;
    }),
    time_zone: `${TZ_LABEL[args.tz] ?? args.tz} (${args.tz})`,
    latest_player_message: sinceText(then, args.now, args.tz),
    hours_since_player_message: Math.round(((args.now - then) / 3600e3) * 10) / 10,
    reply_is_late: args.now - then > LATE_REPLY_MS,
  };
}

// ── the schedule ───────────────────────────────────────────────────────────────────────────────

export type ScheduleRow = {
  api_id: number;
  field_title: string | null;
  start_date: string | null; // wall clock
  start_date_utc: string | null; // instant
  city_identifier: string | null;
  is_cancelled: boolean | null;
  player_count: number | null; // = _count.players (docs/matchday-api-facts.md, roster spots)
  max_player_count: number | null;
};

export type ScheduleEntry = {
  match_id: number;
  field: string;
  when_local: string;
  status: "cancelled" | "already started or finished" | "upcoming";
  open_spots: number | null;
  max_players: number | null;
};

// From the start of the day the player wrote (in their zone) through the next 7 days, as WALL CLOCK
// bounds for mdapi_matches.start_date.
export function scheduleWindow(latestPlayerMsgIso: string, tz: string) {
  const fromYmd = localYmd(Date.parse(latestPlayerMsgIso), tz);
  const toYmd = addDaysYmd(fromYmd, SCHEDULE_DAYS + 1);
  return { fromWall: `${fromYmd}T00:00:00.000Z`, toWall: `${toYmd}T00:00:00.000Z` };
}

// Words that name no particular field.
const STOP = new Set([
  "soccer", "field", "fields", "park", "center", "centre", "sports", "sport", "complex", "turf", "club", "academy",
  "stadium", "pitch", "high", "school", "church", "indoor", "outdoor", "arena", "north", "south", "east", "west",
  "city", "recreation", "futbol", "football", "court", "courts", "the", "and", "matchday", "match", "game", "games",
  "night", "today", "tonight", "tomorrow", "premium",
]);

export function fieldTokens(title: string): string[] {
  const out: string[] = [];
  for (const w of title.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    const lower = w.toLowerCase();
    if (STOP.has(lower) || /^\d+$/.test(w)) continue;
    // An acronym (PRUMC, ATH, NEMP) names a field at 3 letters; a word needs 4.
    if (lower.length >= 4 || (w.length >= 3 && w === w.toUpperCase())) out.push(lower);
  }
  return out;
}

export function mentionedFields(texts: readonly string[], titles: readonly string[]): string[] {
  const hay = ` ${texts.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return [...new Set(titles)].filter((t) => fieldTokens(t).some((tok) => hay.includes(` ${tok} `)));
}

export const DAY_RX = /\b(today|tonight|tomorrow|tmrw|tmr|this (morning|afternoon|evening|weekend)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoy|ma[nñ]ana|esta noche)\b/i;

const wallClockText = (wall: string) =>
  new Date(wall).toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function selectSchedule(args: { rows: readonly ScheduleRow[]; texts: readonly string[]; cityCode: string | null; now: number }) {
  const titles = args.rows.map((r) => r.field_title).filter((t): t is string => !!t);
  const fields = mentionedFields(args.texts, titles);
  let basis: "field" | "city" | null = null;
  let picked: ScheduleRow[] = [];
  if (fields.length > 0) {
    basis = "field";
    picked = args.rows.filter((r) => r.field_title && fields.includes(r.field_title));
  } else if (args.cityCode && args.texts.some((t) => DAY_RX.test(t))) {
    basis = "city";
    picked = args.rows.filter((r) => resolveCityScope(r.city_identifier)?.identifier === args.cityCode);
  }
  const entries: ScheduleEntry[] = picked
    .filter((r) => r.start_date && r.start_date_utc)
    .sort((a, b) => Date.parse(a.start_date_utc!) - Date.parse(b.start_date_utc!))
    .slice(0, SCHEDULE_LIMIT)
    .map((r) => ({
      match_id: r.api_id,
      field: r.field_title ?? "",
      when_local: wallClockText(r.start_date!),
      status: r.is_cancelled ? "cancelled" : Date.parse(r.start_date_utc!) <= args.now ? "already started or finished" : "upcoming",
      open_spots: r.max_player_count != null && r.player_count != null ? Math.max(0, r.max_player_count - r.player_count) : null,
      max_players: r.max_player_count,
    }));
  // The city of the named field, for a thread with no player city.
  const fieldCity = basis === "field" ? picked.find((r) => r.city_identifier)?.city_identifier ?? null : null;
  return { basis, fields, entries, fieldCity, startsById: new Map(picked.map((r) => [r.api_id, r.start_date_utc])) };
}

// ── the guards ─────────────────────────────────────────────────────────────────────────────────

// Clock times in a text, normalized: "8pm", "8 PM", "8:00 p.m." are all "8:00 pm".
export function timesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/gi)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    out.add(`${h}:${m[2] ?? "00"} ${m[3].toLowerCase()}m`);
  }
  return [...out];
}

// Times the reply states that appear in none of the sources it is allowed to quote: the schedule,
// the conversation itself, and the playbook (support hours, 9am to 9pm).
export function unscheduledTimes(reply: string, allowedSources: readonly string[]): string[] {
  const allowed = new Set(allowedSources.flatMap(timesIn));
  return timesIn(reply).filter((t) => !allowed.has(t));
}

const APOLOGY_RX = /\b(sorry|apolog|disculp|perd[oó]n|lo siento)/i;
const SLOW_RX = /\b(slow|late|delayed) (reply|response|answer)\b|sorry (for|about) the (wait|delay)|took (us|me) (a while|so long)|disculpa la demora/i;

export function opensWithApology(reply: string): boolean {
  const first = reply.split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? "";
  return APOLOGY_RX.test(first);
}

export function lateReplyProblem(reply: string, late: boolean): string | null {
  if (!reply.trim()) return null;
  if (late && !opensWithApology(reply)) return "The reply is over 2 hours late but doesn't open with a short sorry.";
  if (!late && SLOW_RX.test(reply)) return "The reply apologizes for a slow reply that wasn't slow.";
  return null;
}

// ── stale drafts ───────────────────────────────────────────────────────────────────────────────

const MATCH_KEY_RX = /^match:(\d+)@(.+)$/;
export const matchKey = (id: number, startUtc: string) => `match:${id}@${startUtc}`;

export function staleDraftReason(prior: { created_at: string; context_keys?: readonly string[] | null }, now: number): string | null {
  const made = Date.parse(prior.created_at);
  if (!Number.isFinite(made)) return null;
  for (const k of prior.context_keys ?? []) {
    const m = k.match(MATCH_KEY_RX);
    const start = m ? Date.parse(m[2]) : NaN;
    if (Number.isFinite(start) && made < start && start <= now) return "a match it mentions has started";
  }
  if (now - made > LATE_REPLY_MS) return "it was made more than 2 hours ago";
  return null;
}
