// MATCH PROMOTION — server-side assembly of one week's promotion plan.
//
// THE WEEK COMES FROM fetchVeoWeek(), NOT FROM A SECOND QUERY. Master Schedule already resolves
// "the matches in the week containing this date" out of the mdapi mirror, with the wall-clock rule,
// the fleet-city filter and the cancelled/deleted exclusions all in one place (veoSchedule.ts:63).
// Promotion needs exactly that set, so it calls it. A second query here would be a second place for
// the wall-clock trap to be got wrong.
//
// WALL CLOCK. Every time on this page is venue-local. fetchVeoWeek has already parsed start_date
// component-wise and handed back dayIdx / time / minutes; nothing here re-parses a date string, and
// nothing here calls new Date() on a mirror timestamp.
//
// push_at IS THE ONE TRUE UTC INSTANT ON THIS PAGE. It is a timestamptz we write ourselves — a real
// moment, not a wall-clock stamp — so it is stored as an ISO instant and formatted for display in
// the venue's city. The two models never share a helper; this comment is the boundary.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVeoWeek, weekMonday, type VeoMatch } from "./veoSchedule";
/* ── THE SAME TIME CLUSTER THE CANCEL ROLLUP USES, NOT A SECOND ONE ──────────────────────────
 * clusterMinutes and slotRiskKey are what rollUpSlotRisk keys a tile's cancel history by, so a
 * time inside the window is already ONE SLOT to the ramp. Newness read exact minutes, so the tile
 * could say "this slot cancelled 2 of 4" and "this time is new" at the same moment, and both could
 * not be true. Two implementations of one window drift and nobody notices until they disagree on a
 * tile, so this imports the window rather than restating it.
 *
 * SAFE TO IMPORT: cancelPatterns' only value imports are venueNormalization and weekWindow, both
 * leaf files with no imports at all, and its useMatchData import is type-only. Checked, because the
 * identical-looking import of fieldEconomics would have dragged React into this nodejs route. */
import { clusterMinutes, slotRiskKey } from "./cancelPatterns";
/* THE SAME TWO RESOLVERS veoSchedule USES, so the unbounded history keys on the same city and the
 * same canonical venue the slate does. A second vocabulary here would mean the two never meet. */
import { CITY_CODE_TO_DISPLAY } from "./scheduleReconcile";
import { canonicalVenueName } from "./venueResolver";

/** The six channels, fixed, and always rendered in this order. */
export const CHANNELS = [
  { key: "wa", short: "WA", label: "WhatsApp" },
  { key: "match_chat", short: "MC", label: "Match chat" },
  { key: "fb", short: "FB", label: "Facebook" },
  { key: "dm", short: "DM", label: "DM" },
  { key: "klaviyo_email", short: "EM", label: "Klaviyo email" },
  { key: "klaviyo_sms", short: "SMS", label: "Klaviyo SMS" },
] as const;

export type ChannelKey = (typeof CHANNELS)[number]["key"];
export const CHANNEL_KEYS = CHANNELS.map((c) => c.key) as readonly ChannelKey[];

/* ── ONE ROW PER PUSH ─────────────────────────────────────────────────────────────────────────
 *
 * Migration 0176. A match has many pushes and a channel has many; each carries its own time, its
 * own topic and its own sent stamp. Everything on match_promotion_plan that described a SEND — the
 * six booleans, push_at, promo_code, pushed_at, pushed_by — is INERT from 0176 onward and is read
 * nowhere. Two sources of truth is how they drift.
 *
 * "THIS CHANNEL IS ON" IS "THIS CHANNEL HAS A ROW". There is no boolean left to carry it. A channel
 * chosen with no date settled is one row with pushAt null, which is 0128's "needs a decision" state
 * moved down a level: per channel rather than per match. */
export type PromoPush = {
  id: number;
  matchApiId: number;
  channel: ChannelKey;
  /** ISO instant, or null = the channel is chosen and the time is not settled. */
  pushAt: string | null;
  /** What this push is about. Per date, because it varies between dates on one channel. */
  topic: string | null;
  /** Per channel in the UI, per row in the table. See 0176. */
  promoCode: string | null;
  /** When somebody marked THIS push sent. NULL is "not sent". */
  pushedAt: string | null;
  /** Who said so. The same identity updatedBy takes: a person, not a delivery receipt. */
  pushedBy: string | null;
};

export type PromoPlan = {
  matchApiId: number;
  /** Every push for this match, any channel, sorted by time with the undated last. */
  pushes: PromoPush[];
  comment: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** An unsaved push. `id` is absent until the route writes it. */
export type DraftPush = { id?: number; channel: ChannelKey; pushAt: string | null; topic: string; promoCode: string };

/* ── OVERDUE, IN ONE PLACE, NOW PER PUSH ──────────────────────────────────────────────────────
 * It used to be `j.at < now` written inline, which is why a push that went out at noon was still
 * red at midnight. Both surfaces read this, so they cannot drift.
 *
 * A PUSH WITH NO push_at IS NOT OVERDUE. NULL means "needs a date", and a decision nobody has made
 * is not a deadline anybody has missed. */
export function isPushOverdue(push: Pick<PromoPush, "pushAt" | "pushedAt"> | null | undefined, now = Date.now()): boolean {
  if (!push?.pushAt) return false;
  if (push.pushedAt) return false;
  return Date.parse(push.pushAt) < now;
}

/** True once somebody has marked THIS push sent. Marking one leaves its siblings alone. */
export const isPushSent = (push: Pick<PromoPush, "pushedAt"> | null | undefined): boolean =>
  !!push?.pushedAt;

/* "Sent Mon 6:30 PM by Ryan". WHO AND WHEN, because the point of leaving a sent row on the strip is
 * that somebody else can see it was handled and by whom. The reader's own clock, like every other
 * push time on this page. */
export function sentStamp(push: Pick<PromoPush, "pushedAt" | "pushedBy">): string {
  if (!push.pushedAt) return "";
  const d = new Date(push.pushedAt);
  if (Number.isNaN(d.getTime())) return "Sent";
  const DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  /* THE NAME, NOT THE ADDRESS. "social@playmatchday.com" is not who, it is where. */
  const who = push.pushedBy ? push.pushedBy.split("@")[0] : null;
  return `Sent ${DOWS[(d.getDay() + 6) % 7]} ${h}:${mm} ${ap}${who ? ` by ${who}` : ""}`;
}

/* A PUSH WITH NO TIME CANNOT BE MARKED SENT. There is nothing to have sent, and writing a stamp
 * against it would blur "needs a date" into "done". */
export const canMarkSent = (push: Pick<PromoPush, "pushAt"> | null | undefined): boolean =>
  !!push?.pushAt;

/* ── READING A PLAN AS CHANNELS ───────────────────────────────────────────────────────────────
 * Derived, never stored. The editor thinks in channels; the table thinks in pushes. */

/** Every channel with at least one row, in CHANNELS order. */
export function channelsOn(plan: PromoPlan | null): ChannelKey[] {
  if (!plan) return [];
  return CHANNEL_KEYS.filter((k) => plan.pushes.some((p) => p.channel === k));
}

/** One channel's pushes, dated first by time, undated last. */
export function pushesFor(plan: PromoPlan | null, channel: ChannelKey): PromoPush[] {
  return (plan?.pushes ?? []).filter((p) => p.channel === channel).sort(byPushTime);
}

/* ── codeFor STOOD HERE AND IS RETIRED ───────────────────────────────────────────────────────
 * It returned "the first non-empty code on this channel's rows", under the comment "The UI writes
 * them all alike" — true only because draftToPushes fanned one channel code across every row.
 *
 * CODES ARE PER PUSH NOW. Two pushes on one channel can carry different codes, or one and none, so
 * "the channel's code" is no longer a question with an answer. Anything that needs a code reads it
 * off the push it belongs to, or asks matchCodes() for the whole set. */

/**
 * Every DISTINCT code on this match's pushes, in push order. Empty when no push carries one.
 *
 * DISTINCT IS CASE-INSENSITIVE, AND THE FIRST SPELLING IS THE ONE SHOWN. Both entry points upper-case
 * on the way in, but production already holds 486 mixed-case codes and `PARMER10` beside `parmer10`
 * is one code and one chip — two would read as two offers on one match.
 */
export function matchCodes(plan: PromoPlan | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of (plan?.pushes ?? []).slice().sort(byPushTime)) {
    const c = p.promoCode?.trim();
    if (!c || seen.has(c.toUpperCase())) continue;
    seen.add(c.toUpperCase());
    out.push(c);
  }
  return out;
}

/** Dated pushes only, earliest first. The worklist, the tile summary and coverage all read this. */
export function datedPushes(plan: PromoPlan | null): PromoPush[] {
  return (plan?.pushes ?? []).filter((p) => p.pushAt).sort(byPushTime);
}

/** Undated before nothing: a row with no time sorts to the END, never to 1970. */
export function byPushTime(a: Pick<PromoPush, "pushAt">, b: Pick<PromoPush, "pushAt">): number {
  if (!a.pushAt && !b.pushAt) return 0;
  if (!a.pushAt) return 1;
  if (!b.pushAt) return -1;
  return Date.parse(a.pushAt) - Date.parse(b.pushAt);
}

/* ── TWO CLOCKS, AND THEY OBEY DIFFERENT RULES ────────────────────────────────────────────────
 *
 * THE MATCH TIME IS A WALL CLOCK AND NEVER RE-RENDERS. start_date carries a Z it does not mean; it
 * is printed once, in the pitch's own clock, labelled "at the pitch". Ryan: "The times of the
 * matches dont change just the push times."
 *
 * EVERY push_at IS AN INSTANT AND ALWAYS RE-RENDERS, in the zone of whoever is reading. Teresa in
 * Madrid and Austin see one push at two clock times, because it IS one moment.
 *
 * THE TRAP THIS SECTION EXISTS FOR: <input type="datetime-local"> HAS NO TIMEZONE. Its value is
 * bare wall-clock characters. Rendering an instant into one and reading it back out are a pair of
 * shifts, and getting either wrong is silent — every push quietly moves and the input still shows
 * what you typed. */

/** The reader's own zone, named. Printed on screen, because a time with no zone label is how this
 *  goes wrong silently. */
export function readerZoneLabel(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "your device"; }
  catch { return "your device"; }
}

/**
 * THE VENUE'S OWN OFFSET FOR THAT DATE, in milliseconds, derived rather than looked up.
 *
 * start_date minus start_date_utc IS the offset — DST included, no city-to-timezone map, no
 * America/Chicago standing in for a zone it is not. Warsaw is the case that kills the shortcut:
 * measured 2026-09-14 the fleet spans UTC−4 (ATL), UTC−5 (ATX, DFW, HOU, OKC, SATX, STL) and
 * UTC+2 (WAW).
 *
 * IT IS THE OFFSET ON KICK-OFF DAY, not a zone. A push a week either side of a DST change would
 * render an hour out in "venue time"; the reader's own clock is unaffected, and a real IANA zone
 * per venue is a separate job with a separate source of truth. Null when either half is missing.
 */
export function venueOffsetMs(startDateWall: string | null, startDateUtc: string | null): number | null {
  if (!startDateWall || !startDateUtc) return null;
  const w = Date.parse(startDateWall), u = Date.parse(startDateUtc);
  if (Number.isNaN(w) || Number.isNaN(u)) return null;
  return w - u;
}

export type ZoneMode = "me" | "venue";

/** The offset to render an instant in. "me" asks the platform, so DST is exact for the reader. */
export function offsetForZone(mode: ZoneMode, atMs: number, venueOffset: number | null): number {
  if (mode === "venue" && venueOffset != null) return venueOffset;
  return -new Date(atMs).getTimezoneOffset() * 60_000;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An instant → the characters a datetime-local input wants, in the chosen zone. */
export function toInputValue(iso: string | null, mode: ZoneMode, venueOffset: number | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  if (mode === "me" || venueOffset == null) {
    /* THE READER'S OWN ZONE IS THE PLATFORM'S. Native accessors already are that zone, DST and
     * all, so there is nothing to shift and nothing to get wrong. */
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  /* A FIXED OFFSET: shift the instant, then read it out in UTC. The same trick start_date already
   * uses. Formatting in UTC is what makes the shift the ONLY thing that moved it. */
  const d = new Date(ms + venueOffset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** The characters back to an instant, undoing exactly the shift above. "" → null, which is a real
 *  value here: the channel is on and the time is not settled. */
export function fromInputValue(v: string, mode: ZoneMode, venueOffset: number | null): string | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  if (mode === "me" || venueOffset == null) {
    /* NATIVE CONSTRUCTION, for the same reason as above — and it is also the only thing that
     * resolves a local time correctly across the reader's own DST change. */
    return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  return new Date(asUtc - venueOffset).toISOString();
}

/**
 * A PUSH INSTANT, PRINTED IN THE CHOSEN CLOCK. "Mon 7:00 PM".
 *
 * ONE FORMATTER FOR EVERY SURFACE — the worklist strip, the tile, the phone's Due list. They used
 * to share `fmtPushLocal`, which was the reader's clock and nothing else; the zone argument is the
 * only thing that changed, and it is passed rather than re-derived so no two of them can disagree
 * about which clock they are in.
 */
export function fmtPushIn(iso: string | null, mode: ZoneMode, venueOffset: number | null): { day: string; time: string } {
  if (!iso) return { day: "", time: "" };
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { day: "", time: "" };
  const DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const useNative = mode === "me" || venueOffset == null;
  const d = useNative ? new Date(ms) : new Date(ms + venueOffset);
  const dow = useNative ? d.getDay() : d.getUTCDay();
  let h = useNative ? d.getHours() : d.getUTCHours();
  const mi = useNative ? d.getMinutes() : d.getUTCMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return { day: DOWS[(dow + 6) % 7], time: `${h}:${String(mi).padStart(2, "0")} ${ap}` };
}

/**
 * HOW LONG BEFORE KICK-OFF. TWO INSTANTS SUBTRACTED, which is what makes it the one number that
 * reads identically in Madrid and in Austin.
 *
 * IT USED TO BE COMPUTED FROM THE WALL CLOCK — `new Date(y, mo, da + dayIdx, hh, mm)` — which
 * builds kick-off in the READER'S zone out of the VENUE'S clock. Right in Austin, wrong in Madrid
 * by the whole zone difference, and wrong silently. Returns null when the kick-off instant is
 * missing, because a made-up number here is worse than no number.
 */
export function leadToKickoff(pushIso: string | null, kickoffUtc: string | null): { text: string; late: boolean } | null {
  if (!pushIso || !kickoffUtc) return null;
  const push = Date.parse(pushIso), kick = Date.parse(kickoffUtc);
  if (Number.isNaN(push) || Number.isNaN(kick)) return null;
  const diff = kick - push;
  const late = diff < 0;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86_400_000);
  const hrs = Math.round((abs % 86_400_000) / 3_600_000);
  const t = days ? `${days}d ${hrs}h` : `${Math.max(1, hrs)}h`;
  return { text: late ? `${t} after` : `${t} before`, late };
}

/** A new push lands 8h before kick-off, which is what the plans on this board already use. It is
 *  an instant, so it is right in every zone at once. Null kick-off falls back to undated. */
export function defaultPushAt(kickoffUtc: string | null): string | null {
  if (!kickoffUtc) return null;
  const k = Date.parse(kickoffUtc);
  return Number.isNaN(k) ? null : new Date(k - 8 * 3_600_000).toISOString();
}

/* ── THE EDITOR'S DRAFT ───────────────────────────────────────────────────────────────────────
 *
 * THE DRAFT HOLDS INSTANTS, NOT INPUT CHARACTERS, and that is the whole reason the round trip
 * works. A datetime-local value is a wall clock with no zone; keeping one in state would mean the
 * stored value silently changes meaning the moment somebody switches zone. So the draft stores the
 * instant, and each render derives the characters for whichever zone is being shown.
 *
 * TOGGLING A CHANNEL OFF KEEPS ITS ROWS. Nothing is written until Save, so the draft IS the undo:
 * turning WhatsApp off hides its pushes and stops sending them, and turning it back on in the same
 * session restores them exactly. That is why there is no confirm on a destructive-looking toggle —
 * a dialog guarding an action that already has an undo teaches people to dismiss dialogs. */
/* ── THE CODE LIVES ON THE PUSH, NOT ON THE CHANNEL ──────────────────────────────────────────
 * `promo_code` has ALWAYS been a per-row column on match_promotion_push, and the route has always
 * written it per row. What collapsed it to one-per-channel was this draft model: DraftChannel held
 * a single `code` and draftToPushes fanned it across every row of the channel, while codeFor read
 * back "the first non-empty one on its rows". So two pushes on one channel could not carry
 * different codes even though the table could hold them.
 *
 * NO MIGRATION WAS NEEDED and none was run. Measured on the 176 live rows: 21 carry a code across
 * 167 (match, channel) groups, 9 of which hold more than one push, and not one of those 9 has
 * differing codes — exactly what a channel-level write produces. Every existing row therefore
 * already carries its channel's code, so the backfill this change would have needed had already
 * happened, continuously, as a side effect of how saving worked. */
export type DraftRow = { key: string; id?: number; pushAt: string | null; topic: string; code: string };
/* `code` IS GONE FROM THE CHANNEL. It is deliberately not left in place unread: a field nothing
 * reads and something still writes is the drift this change exists to end. */
export type DraftChannel = { on: boolean; rows: DraftRow[] };
export type PushDraft = Record<ChannelKey, DraftChannel>;

let draftKeySeq = 0;
/** A stable React key for a row that has no id yet. Never rendered, never sent. */
export const newDraftKey = (): string => `new-${++draftKeySeq}`;

export function draftFromPlan(plan: PromoPlan | null): PushDraft {
  const out = {} as PushDraft;
  for (const k of CHANNEL_KEYS) {
    const rows = pushesFor(plan, k);
    out[k] = {
      on: rows.length > 0,
      // EACH ROW CARRIES ITS OWN. No channel-wide read, so a saved per-push code survives a load.
      rows: rows.map((p) => ({
        key: `p-${p.id}`, id: p.id, pushAt: p.pushAt, topic: p.topic ?? "", code: p.promoCode ?? "",
      })),
    };
  }
  return out;
}

/** What the route is sent: every row of every ON channel, flattened. An OFF channel contributes
 *  nothing, which is how its rows get deleted. */
export function draftToPushes(draft: PushDraft): { id?: number; channel: ChannelKey; at: string | null; topic: string; promoCode: string }[] {
  const out: { id?: number; channel: ChannelKey; at: string | null; topic: string; promoCode: string }[] = [];
  for (const k of CHANNEL_KEYS) {
    const c = draft[k];
    if (!c?.on) continue;
    /* AN ON CHANNEL WITH NO ROWS IS ONE ROW WITH NO DATE. That is how "chosen, not scheduled"
     * survives at all now that there is no boolean to carry it. */
    const rows = c.rows.length > 0 ? c.rows : [{ key: "implicit", pushAt: null, topic: "", code: "" } as DraftRow];
    for (const r of rows) {
      // EACH PUSH SENDS ITS OWN CODE. This was `c.code` — the channel's — written onto every row.
      out.push({ id: r.id, channel: k, at: r.pushAt, topic: r.topic, promoCode: r.code });
    }
  }
  return out;
}

/** The footer's counts, from the same draft the blocks render. */
export function draftSummary(draft: PushDraft): { channels: number; pushes: number; codes: number; undated: number } {
  let channels = 0, pushes = 0, codes = 0, undated = 0;
  for (const k of CHANNEL_KEYS) {
    const c = draft[k];
    if (!c?.on) continue;
    channels++;
    const dated = c.rows.filter((r) => r.pushAt).length;
    pushes += dated;
    /* CODES ARE COUNTED PER PUSH. This was one-or-zero per channel; a channel can now carry a code
     * on one push and none on the next, and the footer has to be able to say so. */
    codes += c.rows.filter((r) => r.code.trim()).length;
    /* "STILL NEEDS A DATE" COUNTS THE CHANNEL, not the rows: a channel with one undated row and a
     * channel with none are the same unfinished decision. */
    if (dated === 0) undated++;
  }
  return { channels, pushes, codes, undated };
}

/* ── NEW TO THE SLATE ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT MARKETING NEEDS TO KNOW. Copy-week carries a city's slate forward unchanged. What it does
 * NOT carry is a field that was not there before, a slot moved to a different weekday, or a slot
 * moved to a different time — and those are the three things a player would notice. So a match is
 * NEW when its own field, or that field's weekday, or that field-weekday's kick-off time did not
 * appear in the PRIOR FOUR WEEKS' slates for its city.
 *
 * ── THE WINDOW IS FOUR WEEKS, AND IT WAS ONE ────────────────────────────────────────────────
 * One week called a returning slot new. A slot that ran three weeks, skipped one and came back is
 * not new to anybody, and it read NEW DAY because the single week it was compared against happened
 * to be the one it missed. MEASURED on the week of 2026-09-21 against the four weeks from
 * 2026-08-24, with the one-week window:
 *
 *   NEW DAY    4 of 8 badges were wrong
 *              ATX LBJ Early College High School Fri  ran weeks 1, 2, 3 · skipped 4 · back
 *              ATX LBJ Early College High School Tue  ran weeks 1, 2 · skipped 3, 4 · back
 *              DFW Lowell H. Strike Middle School Mon ran weeks 1, 3 · back
 *              ATX Stadium Field at Round Rock Sun    ran week 3 · back
 *   NEW TIME   4 wrong, the same shape — ATX The Hattrick L. Sat 20:00 among them
 *   NEW FIELD  0 wrong this week. Fields are the stable one; days and times are what drift.
 *
 * So eight of the badges on screen were telling marketing a returning slot was new. A badge that is
 * wrong half the time is worse than no badge, because it is still believed.
 *
 * AND IT MAKES THE PAGE HOLD ONE WINDOW INSTEAD OF TWO. The cancel history already looks back four
 * weeks (cancelPatterns.ts:158, `for (let i = 3; i >= 0; i--)`), so a tile was comparing its NEW
 * badge against one week and its cancel ratio against four. Two lookbacks on one tile is two
 * different questions being asked in the same visual language.
 *
 * NOT FROM A CREATION DATE. A match created last month for a slot that has never run is still new
 * to a player, and one created yesterday for the same slot as always is not. The comparison is
 * against the slate, never against `created_at`.
 *
 * THE PRIOR SLATE INCLUDES CANCELLED MATCHES, and that is the load-bearing decision. A cancelled
 * match was still scheduled, still published and still copied forward — the slot existed. Measured
 * on 2026-08-25 across 109 matches: treating a cancelled slot as "did not run" flagged 31, and 21
 * of those were slots that had run the week before and been cancelled. Bicentennial Park read as a
 * NEW FIELD in Dallas when it had been on the previous slate and called off. With cancelled
 * counted the rule flags 10, and every one is a real change.
 *
 * PER FIELD, NOT PER CITY. The three tests nest — the field, then that field's day, then that
 * field-day's time. Testing each against the city's whole slate instead loses the case this exists
 * for: NEMP running on a Friday for the first time does not flag if any Austin pitch played a
 * Friday. Measured, the city-wide reading flags 13 of 109 and disagrees on 19, wrongly each time. */
/** How many weeks back the NEW badges compare against. FOUR, matching the cancel history's own
 *  window (cancelPatterns.ts:158) so one tile does not hold two lookbacks. See the block above for
 *  the eight wrong badges the one-week version was producing on 2026-09-21. */
export const NEW_LOOKBACK_WEEKS = 4;

/* ── THE TAXONOMY SPLIT ON THE WRONG AXIS, AND THIS IS THE FIX ───────────────────────────────
 * WAS: NEW FIELD / NEW DAY / NEW TIME.
 *
 * "New day" and "new time" BOTH fired for a slot that had never run, while "new time" ALSO fired
 * for a slot that merely moved. One tag meant two things and two tags meant one thing. The question
 * is not day-versus-time; it is: does this slot have history, and what happened to it?
 *
 *   RETURNING SLATE  this field has run this slot before, and it went missing. NOT new.
 *   NEW FIELD        the venue has never been on a slate.
 *   NEW MATCH        the venue ran, this slot did not, and nothing was dropped to make room.
 *                    Covers a new weekday AND a time added beside one still running.
 *   NEW TIME         this venue-day ran at a nearby time recently and that time is GONE. A move.
 */
export type NewFlag = "field" | "match" | "time" | "back";

/** Shown on the badge. The order of the keys is the precedence order in newnessOf. */
export const NEW_FLAG_LABEL: Record<NewFlag, string> = {
  back: "RETURNING SLATE",
  field: "NEW FIELD",
  match: "NEW MATCH",
  time: "NEW TIME",
};

/** One line each, for the key. Read weekly by people who know what they mean already. */
export const NEW_FLAG_NOTE: Record<NewFlag, string> = {
  back: "Ran here before, missed last time. Not new.",
  field: "Venue is new.",
  match: "A slot this field has never run. New day, or an extra time.",
  time: "An existing match moved. The old time is gone.",
};

/* ── HOW FAR BACK "HAVE WE EVER RUN THIS" REACHES: UNBOUNDED, AND THAT IS MEASURED ───────────
 * The three NEW tests compare against NEW_LOOKBACK_WEEKS. RETURNING cannot: four weeks is enough
 * to ask "is this new" and nowhere near enough to ask "have we ever run this".
 *
 * MEASURED over 13 settled weeks to 2026-10-05, 1,038 tiles, against 93 weeks of slates
 * (scripts/_slate_reach.mts). 70 slots would have been badged NEW by the 4-week window. 59 were
 * genuinely never seen. ELEVEN had run before and were returning, and their gaps were:
 *
 *     6, 6, 12, 12, 13, 17, 18, 26, 40, 57, 75 weeks
 *
 * THERE IS NO CEILING IN THAT DISTRIBUTION. It is a flat tail that ends where the DATA ends, not
 * where the behaviour does — 75 weeks was the oldest slate available, so the true tail may be
 * longer. Every candidate cutoff leaves a known-wrong badge: 8 weeks catches 2 of 11, 13 catches 5,
 * 26 catches 8. Picking any of them means choosing how many familiar slots get called new.
 *
 * AND A WINDOW WOULD MAKE THE ANSWER DEPEND ON WHEN YOU ASK. The same slot returning after 30 weeks
 * would read RETURNING one week and NEW the next as the window slid past it, which is the failure
 * the one-week version already produced once.
 *
 * So it is UNBOUNDED: every slate this estate has ever had. It costs one lean query of three
 * columns over ~10k rows (1.7s, measured), run in parallel with the four week fetches it sits
 * beside, and it answers a question no window can. */
export const RETURNING_LOOKBACK = "all history" as const;

/** One city's prior slate over NEW_LOOKBACK_WEEKS, indexed for the three nested tests.
 *
 *  `venueDayTime` holds CLUSTER keys, not raw minutes — see buildPriorSlate. `clusters` keeps the
 *  cluster members so a shifted slot can say on hover what it ran at before and for how long. */
export type CitySlate = {
  venues: Set<string>;
  venueDay: Set<string>;
  /* THE RAW PRIOR MINUTES PER venue|dayIdx, and how many WEEKS carried each.
   *
   * NOT PRE-CLUSTERED, and that was a real bug: clustering the prior minutes ALONE means the
   * candidate time is never a member of any cluster, so slotRiskKey falls through to the candidate's
   * own raw minute, which is by definition absent from the slate — and every shifted slot still
   * badged NEW TIME. Measured: 0 of 110 tiles changed, on a week where I had found the case myself.
   * The window has to be computed over the prior minutes PLUS the candidate; see timeSeenNear. */
  minutes: Map<string, Map<number, number>>;
};
export type PriorSlate = Map<string, CitySlate>;

/** Anything with the four fields the comparison reads. VeoMatch satisfies it structurally.
 *
 *  `weekKey` is OPTIONAL and only the prior slate uses it: it is how "ran 3 of the last 4 weeks" is
 *  counted in weeks rather than in matches. fetchPromoWeek tags each prior week with its own Monday. */
export type SlotLike = Pick<VeoMatch, "city" | "venue" | "dayIdx" | "minutes"> & { weekKey?: string };

/* A UNION ACROSS THE WHOLE WINDOW, NOT A WEEK PER ENTRY. The question is "has this slot appeared
 * at all recently", so four weeks of matches go in as one list and presence in ANY of them is
 * presence. Keeping the weeks apart would let someone write "present in 3 of 4", which is the cancel
 * ramp's question and not this one. */
export function buildPriorSlate(prior: SlotLike[]): PriorSlate {
  const out: PriorSlate = new Map();
  /* ONE PASS. The minutes are kept RAW, per venue|dayIdx, with a count of the distinct prior WEEKS
   * that carried each — not a count of matches, because two matches at one time in one week is one
   * week, and weeks is the number an operator is reading when they ask how settled a slot was. */
  const weeksSeen = new Map<string, Set<string>>();
  for (const m of prior) {
    let c = out.get(m.city);
    if (!c) { c = { venues: new Set(), venueDay: new Set(), minutes: new Map() }; out.set(m.city, c); }
    c.venues.add(m.venue);
    c.venueDay.add(`${m.venue}|${m.dayIdx}`);
    const fd = `${m.venue}|${m.dayIdx}`;
    const byMin = c.minutes.get(fd) ?? c.minutes.set(fd, new Map()).get(fd)!;
    /* DISTINCT WEEKS, COUNTED BY THE CALLER'S OWN weekKey. Two matches at one time in one week is
     * ONE week, and weeks is the number the tooltip reports. A caller that omits weekKey gets every
     * row in one bucket, so the count is 1: honest for a flat list rather than silently inflated. */
    const seenKey = `${fd}|${m.minutes}`;
    const set = weeksSeen.get(`${m.city}|${seenKey}`)
      ?? weeksSeen.set(`${m.city}|${seenKey}`, new Set()).get(`${m.city}|${seenKey}`)!;
    set.add(m.weekKey ?? "");
    byMin.set(m.minutes, set.size);
  }
  return out;
}

/* ── IS THIS TIME THE SAME SLOT AS ONE THE SLATE ALREADY HELD? ────────────────────────────────
 *
 * THE CANDIDATE IS CLUSTERED WITH THE PRIOR MINUTES, not against clusters built without it. That
 * distinction is the whole correctness of this function: cluster [1170] alone and 1140 belongs to no
 * cluster, so a 19:30 slot returning at 19:00 reads as new. Cluster [1140, 1170] together and they
 * are one slot, which is exactly what the cancel ramp already says about that pitch on that weekday.
 *
 * clusterMinutes and slotRiskKey are the CANCEL ROLLUP'S OWN helpers, imported rather than restated,
 * so the two cannot drift into disagreeing on a tile. */
function timeSeenNear(m: SlotLike, slate: PriorSlate): { hit: boolean; others: [number, number][] } {
  const c = slate.get(m.city);
  const byMin = c?.minutes.get(`${m.venue}|${m.dayIdx}`);
  if (!byMin || byMin.size === 0) return { hit: false, others: [] };
  const clusters = clusterMinutes([...byMin.keys(), m.minutes]);
  const key = slotRiskKey(m.venue, m.dayIdx, m.minutes, clusters);
  const others: [number, number][] = [];
  let hit = false;
  for (const [mins, weeks] of byMin) {
    if (slotRiskKey(m.venue, m.dayIdx, mins, clusters) !== key) continue;
    hit = true;
    if (mins !== m.minutes) others.push([mins, weeks]);
  }
  return { hit, others };
}

/* ── WHAT A SHIFTED SLOT RAN AT BEFORE ────────────────────────────────────────────────────────
 * The badge is gone for a shift inside the window; the information is not, and this is what the
 * tooltip says instead. Null when the slot is genuinely new, or when it has not moved at all. */
export function priorTimesFor(m: SlotLike, slate: PriorSlate): { times: string[]; weeks: number } | null {
  const { hit, others } = timeSeenNear(m, slate);
  if (!hit || others.length === 0) return null;
  const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  return {
    times: others.sort((a, b) => a[0] - b[0]).map(([mins]) => hhmm(mins)),
    weeks: Math.max(...others.map(([, n]) => n)),
  };
}

/* ── HAS THIS FIELD EVER RUN THIS SLOT? ──────────────────────────────────────────────────────
 * Unbounded history, keyed two ways because the two NEW tags it intercepts ask different questions:
 * NEW FIELD asks about the venue, NEW MATCH asks about the venue on that weekday. */
export type EverSeen = {
  /** `city|venue` — every venue that has ever been on a slate. */
  venues: Set<string>;
  /** `city|venue|dayIdx` — every venue-weekday that has ever been on a slate. */
  venueDay: Set<string>;
};

/** Empty history. Used by callers that do not have it, which then get the NEW tags unmodified. */
export const NO_HISTORY: EverSeen = { venues: new Set(), venueDay: new Set() };

/** This week's kick-offs per `city|venue|dayIdx`, which step 3 needs to tell a move from an
 *  addition. Built by fetchPromoWeek from the week it is already holding. */
export type CurrentTimes = Map<string, Set<number>>;
export const currentTimesOf = (ms: readonly SlotLike[]): CurrentTimes => {
  const out: CurrentTimes = new Map();
  for (const m of ms) {
    const k = `${m.city}|${m.venue}|${m.dayIdx}`;
    (out.get(k) ?? out.set(k, new Set()).get(k)!).add(m.minutes);
  }
  return out;
};

/* ── DID A PRIOR TIME AT THIS VENUE-DAY GO AWAY? ─────────────────────────────────────────────
 * THIS IS THE PART THAT IS HARDER THAN IT LOOKS, and it is the whole difference between NEW MATCH
 * and NEW TIME. "Is this time near a prior time" cannot tell an addition from a move: both answer
 * no. The second question is whether a time the slate held is still being run.
 *
 *   Westlake keeps its 6:00 PM and gains a 7:00 PM   -> nothing dropped -> an ADDITION -> NEW MATCH
 *   PRUMC's 6:00 PM becomes 6:30 PM, no 6:00 left    -> 6:00 dropped   -> a MOVE     -> NEW TIME
 *
 * CLUSTERED ON BOTH SIDES, and clustered TOGETHER, for the same reason timeSeenNear does it: a
 * 19:00 that became 19:15 has not gone away, it drifted inside the window the cancel ramp already
 * treats as one slot. Comparing raw minutes would call every small drift a disappearance and put
 * NEW TIME on half the grid. */
function droppedTimeAt(m: SlotLike, slate: PriorSlate, current: CurrentTimes): number | null {
  const prior = slate.get(m.city)?.minutes.get(`${m.venue}|${m.dayIdx}`);
  if (!prior || prior.size === 0) return null;
  const now = current.get(`${m.city}|${m.venue}|${m.dayIdx}`) ?? new Set<number>();
  const clusters = clusterMinutes([...prior.keys(), ...now]);
  const liveKeys = new Set([...now].map((x) => slotRiskKey(m.venue, m.dayIdx, x, clusters)));
  for (const p of prior.keys()) {
    if (!liveKeys.has(slotRiskKey(m.venue, m.dayIdx, p, clusters))) return p;
  }
  return null;
}

/**
 * The most significant thing that changed about this slot, or null.
 *
 * ── PRECEDENCE, AT MOST ONE TAG ──────────────────────────────────────────────────────────────
 *   0. RETURNING, checked FIRST — see below.
 *   1. venue never on a slate                                  -> field
 *   2. venue present, venue|dayIdx absent                      -> match  (a new weekday)
 *   3. venue|dayIdx present, this time near no prior time      -> match if nothing was dropped,
 *                                                                 time if a prior time went away
 *   4. otherwise                                               -> null
 *
 * ── RETURNING IS A PRECEDENCE RULE, NOT A FOURTH TAG ─────────────────────────────────────────
 * Its whole job is to stop a slot that went missing from coming back wearing NEW. So it fires ONLY
 * where one of the three NEW tests would have fired — it intercepts a claim, it does not decorate a
 * tile nothing was claiming anything about.
 *
 * THAT DISTINCTION IS THE DIFFERENCE BETWEEN A USEFUL BADGE AND A FLOOD. Measured over 13 settled
 * weeks, 1,038 tiles: as an interception it lands on 11 tiles (1.1%). Fired on any slot whose last
 * outing was cancelled — the other reading of "it did not happen" — it lands on 179 (17.2%), one
 * tile in six, which drowns the eleven it exists for. The mock asserts the interception directly:
 * the returning tile carries `wouldbe="match"`, "not filling a gap where no tag would have
 * rendered".
 *
 * AND THE CANCELLED CASE IS ALREADY HANDLED, which is why it does not need its own trigger. A
 * cancelled match COUNTS AS PRESENT in the prior slate — deliberate, with 109 matches of
 * measurement behind it (see the block above NEW_LOOKBACK_WEEKS): a cancelled slot was still
 * scheduled, still published and still copied forward. So a slot cancelled last week is IN the
 * 4-week slate, reads as no change, and needs no interception. A slot cancelled six weeks ago and
 * absent since is outside that window, would read NEW, and this is what catches it. "Cancelled" and
 * "absent" are one rule rather than two precisely because of that decision.
 *
 * NOT APPLIED TO A MOVE. Step 3's `time` means the venue-day IS on the recent slate — there is no
 * gap to return from, so there is nothing to intercept.
 *
 * `history` DEFAULTS TO EMPTY so every existing caller keeps the NEW tags unchanged and only
 * fetchPromoWeek, which has the unbounded read, gets the interception.
 */
export function newnessOf(
  m: SlotLike,
  slate: PriorSlate,
  history: EverSeen = NO_HISTORY,
  current: CurrentTimes = new Map(),
): NewFlag | null {
  const flag = newFlagOf(m, slate, current);
  if (flag == null) return null;
  // THE INTERCEPTION. Only the two "never ran this" claims can be wrong about a returning slot.
  if (flag === "field" && history.venues.has(`${m.city}|${m.venue}`)) return "back";
  if (flag === "match" && history.venueDay.has(`${m.city}|${m.venue}|${m.dayIdx}`)) return "back";
  return flag;
}

/** The three NEW tests alone, with no returning interception. Exported so the view can say which
 *  label RETURNING displaced — the only way to check from the screen that the rule fired. */
export function newFlagOf(m: SlotLike, slate: PriorSlate, current: CurrentTimes = new Map()): NewFlag | null {
  const c = slate.get(m.city);
  if (!c) return "field";
  if (!c.venues.has(m.venue)) return "field";
  // A NEW WEEKDAY AT A KNOWN FIELD. Was NEW DAY; it is a slot this field has never run, which is
  // the same statement as an extra time, so both are NEW MATCH now.
  if (!c.venueDay.has(`${m.venue}|${m.dayIdx}`)) return "match";
  /* THE TIME TEST ASKS THE CLUSTER, NOT THE MINUTE. A kick-off inside the window shares a cluster
   * with a time the slate already held, so a 19:30 slot returning at 19:00 is not new — which is
   * what the cancel ramp has always said about that pitch on that weekday. */
  if (timeSeenNear(m, slate).hit) return null;
  // NEAR NO PRIOR TIME. An ADDITION if everything the slate held is still running, a MOVE if not.
  return droppedTimeAt(m, slate, current) == null ? "match" : "time";
}

/** The prior time a move left behind, as HH:MM, for the tooltip. Null unless this slot is a move. */
export function movedFromTime(m: SlotLike, slate: PriorSlate, current: CurrentTimes): string | null {
  if (newFlagOf(m, slate, current) !== "time") return null;
  const mins = droppedTimeAt(m, slate, current);
  return mins == null ? null : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** A match plus whatever plan exists for it. `plan` is null when no row has ever been written. */
export type PromoMatch = VeoMatch & {
  plan: PromoPlan | null;
  /* planned | needs-decision | none | cancelled — derived once here so no view re-derives it.
   * CANCELLED IS ITS OWN STATE, NOT A VARIANT OF "none". Nothing was missed; the match was called
   * off, so it is excluded from the no-plan count and totalled separately per city. */
  state: "planned" | "needs-decision" | "none" | "cancelled";
  /** The most significant thing that changed about this slot, or null. */
  newFlag: NewFlag | null;
  /** When newFlag is "back", the NEW tag it intercepted. Null otherwise. */
  wouldBe: NewFlag | null;
  /** When newFlag is "time", the prior kick-off that went away — what makes it a move. */
  movedFrom: string | null;
  /* WHAT THIS SLOT RAN AT BEFORE, when its kick-off moved INSIDE the cluster window. Null when it
   * has not moved, or when the slot is genuinely new. The badge is gone for this case — the cancel
   * ramp already calls it one slot — and this is where the information went instead. */
  shiftedFrom: { times: string[]; weeks: number } | null;
};

export type PromoWeek = {
  weekStart: string;
  /** Pushes scoped to a city or a field. Same table as the match pushes; see 0191. */
  generals: GeneralPush[];
  /** field_id -> its FIELD-scoped tags (key_field, starting_11). A pitch reads the same on every
   *  tile it appears on, this week and next. */
  tagsByField: Record<number, string[]>;
  /** match api_id -> its MATCH-scoped tags (priority). Dies with the match, so there is nothing to
   *  expire: see the note on TAG_META. */
  tagsByMatch: Record<number, string[]>;
  /** The Monday of the EARLIEST week the NEW test compared against — printed on the page so the
   *  rule is legible without asking, and so a wrong window is visible rather than silent. */
  priorWeekStart: string;
  /** How many weeks that window spans. Carried so the label and the tooltip render the real number
   *  rather than a 4 typed into a component that would not change when the constant did. */
  priorWeeks: number;
  days: { dow: string; date: number; iso: string; today: boolean }[];
  matches: PromoMatch[];
  /** False when match_promotion_push is not in the database yet — every match reads as "no plan". */
  planTableReady: boolean;
  generatedAt: string;
};

/** Any channel chosen. This — not the presence of a parent row — separates "no plan" from a plan. */
export function anyChannel(p: PromoPlan | null): boolean {
  return (p?.pushes.length ?? 0) > 0;
}

/* CANCELLED WINS OVER EVERY OTHER STATE. A cancelled match with a push planned is not "planned" —
 * the push is moot — and a cancelled match with no push is not "no plan", because no plan was
 * needed. The flag is passed rather than read off the plan, so the existing single-argument
 * callers keep their exact behaviour. */
export function stateOf(p: PromoPlan | null, isCancelled = false): PromoMatch["state"] {
  if (isCancelled) return "cancelled";
  if (!p || p.pushes.length === 0) return "none";
  /* PLANNED THE MOMENT ANY PUSH HAS A TIME. A match with WhatsApp dated and Klaviyo still undated
   * is planned AND carries an amber channel; the tile says planned because something is going out,
   * and the editor is where the undated one is visible. */
  return p.pushes.some((x) => x.pushAt) ? "planned" : "needs-decision";
}

/**
 * SELECT("*") IS DELIBERATE, AND IT IS THE adminAuth PRECEDENT.
 *
 * Code deploys before a migration is applied. Naming columns that do not exist yet turns every load
 * of this page into a 500; `*` degrades to "no plan on every match", which is exactly what is true
 * before the table exists. The write does NOT get this treatment — it fails loudly.
 */
async function fetchPlans(
  sb: SupabaseClient,
  ids: number[],
): Promise<{ plans: Map<number, PromoPlan>; ready: boolean }> {
  const plans = new Map<number, PromoPlan>();
  if (ids.length === 0) return { plans, ready: true };
  let ready = true;

  const planFor = (id: number): PromoPlan => {
    let p = plans.get(id);
    if (!p) { p = { matchApiId: id, pushes: [], comment: null, updatedBy: null, updatedAt: null }; plans.set(id, p); }
    return p;
  };

  /* THE PUSHES ARE THE PLAN. Migration 0176. Not one row per match any more, so this reads the
   * child table and groups; the parent is read only for the things that stayed on it. */
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { data, error } = await sb.from("match_promotion_push").select("*").in("match_api_id", chunk);
    if (error) { ready = false; break; }
    for (const r of data ?? []) {
      /* A CHANNEL VALUE THE APP DOES NOT KNOW IS DROPPED, not rendered as a seventh column. The
       * CHECK constraint makes it unreachable; this is what keeps it unreachable in the UI too. */
      if (!(CHANNEL_KEYS as readonly string[]).includes(r.channel)) continue;
      planFor(r.match_api_id).pushes.push({
        id: r.id,
        matchApiId: r.match_api_id,
        channel: r.channel as ChannelKey,
        pushAt: r.push_at ?? null,
        topic: r.topic ?? null,
        promoCode: r.promo_code ?? null,
        pushedAt: r.pushed_at ?? null,
        pushedBy: r.pushed_by ?? null,
      });
    }
  }
  if (!ready) return { plans, ready };

  /* THE PARENT, FOR THE COMMENT AND WHO LAST TOUCHED IT, AND FOR NOTHING ELSE. Its six booleans,
   * push_at, promo_code, pushed_at and pushed_by are inert from 0176 and are not read here or
   * anywhere: two sources of truth is how they drift. A parent row with no pushes is not a plan,
   * so it does not create one. */
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { data } = await sb
      .from("match_promotion_plan")
      .select("match_api_id, comment, updated_by, updated_at")
      .in("match_api_id", chunk);
    for (const r of data ?? []) {
      const p = plans.get(r.match_api_id);
      if (!p) continue;
      p.comment = r.comment ?? null;
      p.updatedBy = r.updated_by ?? null;
      p.updatedAt = r.updated_at ?? null;
    }
  }

  for (const p of plans.values()) p.pushes.sort(byPushTime);
  return { plans, ready };
}

/* ── EVERY SLATE THIS ESTATE HAS EVER HAD, IN ONE LEAN QUERY ─────────────────────────────────
 * Three columns, every non-deleted match before the displayed week. ~10k rows, 11 paged reads,
 * 1.7s measured — and it runs INSIDE the Promise.all beside the four week fetches, so it costs
 * wall clock only if it is the slowest of them.
 *
 * NOT fetchVeoWeek, AND NOT A LOOP OF THEM. Unbounded is 90+ calls; this is one. The cost of that
 * shortcut is that the slot fields are derived here rather than there, so the derivation is copied
 * from veoSchedule DELIBERATELY AND MINIMALLY:
 *
 *   - `local()` strips the offset rather than parsing it. start_date is LOCAL WALL CLOCK carrying a
 *     Z it does not mean; `new Date(s)` re-shifts it and lands a 7pm match on the wrong day.
 *   - the weekday is (getDay()+6)%7, Monday=0. veoSchedule computes dayIdx against the displayed
 *     week's Monday, which for a match INSIDE that week is the same number — and every row here is
 *     inside its own week by construction.
 *   - the venue is canonicalVenueName, the same function the slate uses.
 *
 * CANCELLED MATCHES COUNT, for the reason the four-week slate counts them: a cancelled slot was
 * still scheduled and still published. The query does not filter on is_cancelled at all.
 *
 * CITY IS THE RAW city_identifier, matching VeoMatch.city only after CITY_CODE_TO_DISPLAY — so the
 * caller maps it once and this returns display cities, or the keys never meet. */
export async function fetchEverSeen(sb: SupabaseClient, beforeIso: string): Promise<EverSeen> {
  const venues = new Set<string>();
  const venueDay = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("mdapi_matches")
      .select("start_date, city_identifier, field_title")
      .is("deleted_at", null).lt("start_date", beforeIso)
      .order("api_id").range(from, from + 999);
    if (error) throw new Error(`mdapi_matches history: ${error.message}`);
    for (const r of data ?? []) {
      const city = CITY_CODE_TO_DISPLAY[(r.city_identifier as string) ?? ""] ?? null;
      if (!city) continue; // only fleet cities appear in the grid, so only they can be "seen before"
      const d = new Date(String(r.start_date).replace(/([+-]\d\d:\d\d|Z)$/, ""));
      const venue = canonicalVenueName((r.field_title as string) ?? "") || ((r.field_title as string) ?? "Unknown");
      venues.add(`${city}|${venue}`);
      venueDay.add(`${city}|${venue}|${(d.getDay() + 6) % 7}`);
    }
    if ((data ?? []).length < 1000) break;
  }
  return { venues, venueDay };
}

export async function fetchPromoWeek(
  sb: SupabaseClient,
  now: Date,
  weekRef: Date = now,
): Promise<PromoWeek> {
  /* THE DISPLAYED WEEK INCLUDES CANCELLED MATCHES. Ryan: "the operator wants to be able to see
   * what cancelled last week by going to last week." They arrive flagged and are given their own
   * state below, so they never reach the no-plan count. /api/veo is untouched: it calls
   * fetchVeoWeek without this argument and still receives live matches only. */
  const week = await fetchVeoWeek(sb, now, weekRef, null, true);
  const ids = week.matches.map((m) => m.apiId);
  const { plans, ready } = await fetchPlans(sb, ids);

  /* THE PRIOR FOUR WEEKS, and their SLATE rather than their play. Built from the Monday of the week
   * on screen, so paging back moves the whole comparison with it. `includeCancelled` is the whole
   * point (see newnessOf): a cancelled slot was still scheduled and still published.
   *
   * FOUR CALLS, ONE ROUND TRIP OF LATENCY. Promise.all rather than a loop, and fetchVeoWeek rather
   * than fetchVeoRange because the range reader OMITS dayIdx — the weekday would have to be
   * re-derived from a date string, and a second derivation of the weekday is exactly the kind of
   * thing that puts a slot in the wrong bucket on a DST boundary. */
  const [y, mo, d] = week.weekStart.split("-").map(Number);
  /* THE UNBOUNDED HISTORY RIDES ALONG WITH THE FOUR WEEK FETCHES, so it adds no round trip of its
   * own. It answers a different question from the slate — "have we EVER run this" against "is this
   * new" — and needs no window; see RETURNING_LOOKBACK. */
  const [priors, history] = await Promise.all([
    Promise.all(Array.from({ length: NEW_LOOKBACK_WEEKS }, (_, i) =>
      fetchVeoWeek(sb, now, new Date(y, mo - 1, d - 7 * (i + 1)), null, true))),
    fetchEverSeen(sb, week.weekStart),
  ]);
  /* OLDEST FIRST, so priorWeekStart below is the start of the window rather than of whichever call
   * resolved first. Array.from produced i=0 as one week back, so the earliest is the LAST entry. */
  /* EACH PRIOR WEEK TAGGED WITH ITS OWN MONDAY, so "ran 3 of the last 4 weeks" counts weeks and not
   * matches — a pitch running twice on one Friday is one week, not two. */
  const slate = buildPriorSlate(priors.flatMap((w) => w.matches.map((m) => ({ ...m, weekKey: w.weekStart }))));

  /* THIS WEEK'S KICK-OFFS PER venue|day, which is what tells a time ADDED beside a running one
   * from a time that MOVED. Built from the week already in hand — the slate cannot answer it,
   * because the slate is what the slot is being compared against. */
  const current = currentTimesOf(week.matches);

  const matches: PromoMatch[] = week.matches.map((m) => {
    const plan = plans.get(m.apiId) ?? null;
    /* THE SHIFT IS COMPUTED WHERE THE SLATE LIVES. The client has no slate and building one there
     * would mean shipping four weeks of matches to the browser to answer a tooltip. */
    return {
      ...m, plan, state: stateOf(plan, m.isCancelled),
      newFlag: newnessOf(m, slate, history, current),
      /* WHAT RETURNING DISPLACED. Null unless the interception fired — it is the only way to check
       * from the screen that the rule ran rather than that no tag happened to apply. */
      wouldBe: newnessOf(m, slate, history, current) === "back" ? newFlagOf(m, slate, current) : null,
      /** The time a move left behind, so NEW TIME can say what makes it a move. */
      movedFrom: movedFromTime(m, slate, current),
      shiftedFrom: priorTimesFor(m, slate),
    };
  });
  // City, then day, then time. The grid renders in this order and so does the worklist fallback.
  matches.sort((a, b) => a.city.localeCompare(b.city) || a.dayIdx - b.dayIdx || a.minutes - b.minutes);

  const fieldIds = matches.map((m) => m.fieldId).filter((x): x is number => x != null);
  const [generals, tags] = await Promise.all([
    fetchGeneralPushes(sb, week.days),
    fetchPromoTags(sb, fieldIds, matches.map((m) => m.apiId)),
  ]);

  return {
    weekStart: week.weekStart,
    priorWeekStart: priors[priors.length - 1].weekStart,
    priorWeeks: NEW_LOOKBACK_WEEKS,
    days: week.days,
    matches,
    generals,
    tagsByField: tags.byField,
    tagsByMatch: tags.byMatch,
    planTableReady: ready,
    generatedAt: now.toISOString(),
  };
}

/* ── COVERAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 * COLOUR MARKS THE EXCEPTION, WHICH MEANS THE ANSWER DEPENDS ON THE WEEK.
 *
 * The Coverage grid used to fill every matches-but-no-push cell with a coral block reading OPEN.
 * With `match_promotion_plan` empty — which it was on 2026-08-25, for all 109 matches — that is
 * every cell in the grid, and a colour that is everywhere carries no information. It read as an
 * alarm about the whole week when it was only saying "nobody has started yet".
 *
 * So: `anyPlanned` decides whether OPEN is worth marking at all. With no push anywhere, the page
 * says so ONCE above the grid and the cells stay quiet. With pushes in place, the covered cell is
 * the loud one and open carries a thin coral edge — the exception, marked quietly.
 *
 * WHAT MUST SURVIVE EITHER WAY is the distinction this view exists to answer: a day with matches
 * and no push versus a day with no matches. That is carried by CONTENT, not by colour — an open
 * cell prints its field and time, an empty one prints a dash — so it holds even when nothing is
 * coloured at all. */
export type CoverageState = "planned" | "open" | "none";

/** One city-day. `planned` iff any match that day has at least one DATED push on it. Unchanged in
 *  meaning by 0176: the question is still "is anything going out", only the shape moved. */
export function coverageStateOf(dayMatches: PromoMatch[]): CoverageState {
  if (dayMatches.length === 0) return "none";
  return dayMatches.some((m) => datedPushes(m.plan).length > 0) ? "planned" : "open";
}

export type CoverageSummary = {
  cities: number;
  plannedDays: number;
  openDays: number;
  /** Matches sitting on an open day — the number the banner quotes. */
  openMatches: number;
  /** False ⟺ not one push exists in the whole week. Drives the banner AND the colour. */
  anyPlanned: boolean;
};

export function coverageSummary(week: Pick<PromoWeek, "matches" | "days">): CoverageSummary {
  const cities = [...new Set(week.matches.map((m) => m.city))];
  let plannedDays = 0, openDays = 0, openMatches = 0;
  for (const city of cities) {
    for (let i = 0; i < week.days.length; i++) {
      const dm = week.matches.filter((m) => m.city === city && m.dayIdx === i);
      const st = coverageStateOf(dm);
      if (st === "planned") plannedDays++;
      else if (st === "open") { openDays++; openMatches += dm.length; }
    }
  }
  return { cities: cities.length, plannedDays, openDays, openMatches, anyPlanned: plannedDays > 0 };
}

/** The sentence shown above the grid. Two shapes, because the two weeks are different facts. */
export function coverageCaption(s: CoverageSummary): string {
  if (!s.anyPlanned) {
    return `No pushes planned this week. ${s.openMatches} match${s.openMatches === 1 ? "" : "es"} open.`;
  }
  return `${s.plannedDays} covered day${s.plannedDays === 1 ? "" : "s"} · ${s.openDays} day${s.openDays === 1 ? "" : "s"} with matches and no push (${s.openMatches} match${s.openMatches === 1 ? "" : "es"}).`;
}

export { weekMonday };

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * GENERAL PUSHES — a push scoped to a CITY or a FIELD rather than to one match
 *
 * Ryan: "We should add an option per city so we can add general pushes (pushing all the slate to
 * registered users or pushing general slate for a specific field for example)."
 *
 * ── ONE TABLE, NOT TWO ───────────────────────────────────────────────────────────────────────
 * Migration 0191 puts scope on match_promotion_push rather than giving general pushes a table of
 * their own. Ryan's reasoning, and it is the right one: the day queue and the tile's coverage are
 * two projections of ONE set, and two tables means two reads, two filters and two places to forget
 * one. The symptom would be a queue total that disagrees with the grid by a number nobody can
 * source, weeks later.
 *
 * ── IT COVERS THE DAY IT IS SENT FOR, NOT THE WEEK ──────────────────────────────────────────
 * Built the other way first and Austin went to zero "no plan" instantly, at which point the column
 * tells nobody anything. A city wanting its week covered sends one a day, which is what the
 * operator does anyway. So coverage is matched on the DAY, and a general push with no date covers
 * nothing at all — an undated push has not been scheduled, and a match cannot be covered by a
 * decision nobody has made. */
export type PushScope = "match" | "field" | "city";

export type GeneralPush = {
  id: number;
  scope: Exclude<PushScope, "match">;
  channel: ChannelKey;
  pushAt: string | null;
  topic: string | null;
  promoCode: string | null;
  pushedAt: string | null;
  pushedBy: string | null;
  /** The city header it was created from. Present on BOTH scopes; see 0191's shape CHECK. */
  city: string;
  /** mdapi field_id, for a field-scoped push. Null on a city push. */
  fieldId: number | null;
  /** Who it went to, in the operator's own words. Never derived. */
  audience: string | null;
};

/** The day column a general push falls in, or null when it carries no date. */
export function generalPushDayIdx(g: Pick<GeneralPush, "pushAt">, days: { iso: string }[]): number | null {
  if (!g.pushAt) return null;
  /* THE READER'S OWN CLOCK, like every other push time on this page. A push is scheduled for a
   * moment, and which day that moment falls in is a question about the reader's calendar. */
  const d = new Date(g.pushAt);
  if (Number.isNaN(d.getTime())) return null;
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const i = days.findIndex((x) => x.iso === ymd);
  return i >= 0 ? i : null;
}

/** Every general push that covers this match: same day, and the city or the field matches. */
export function generalsCovering(
  m: Pick<PromoMatch, "city" | "dayIdx" | "fieldRaw"> & { fieldId?: number | null },
  generals: readonly GeneralPush[],
  days: { iso: string }[],
): GeneralPush[] {
  return generals.filter((g) => {
    if (generalPushDayIdx(g, days) !== m.dayIdx) return false;
    if (g.scope === "city") return g.city === m.city;
    return g.fieldId != null && g.fieldId === (m.fieldId ?? null);
  });
}

/* THE THREE COVERAGE STATES, AND THE MIDDLE ONE IS THE FEATURE. A general push is real promotion,
 * so a match it carried must not read as forgotten; it is not a push written for that match, so it
 * must not read the same either. Cancelled still wins over all three: nothing was missed. */
export function coverageOf(
  m: PromoMatch,
  generals: readonly GeneralPush[],
  days: { iso: string }[],
): "planned" | "covered" | "none" | "needs-decision" | "cancelled" {
  if (m.state === "cancelled") return "cancelled";
  if (m.state === "planned" || m.state === "needs-decision") return m.state;
  return generalsCovering(m, generals, days).length > 0 ? "covered" : "none";
}

/** "in city slate" / "in Hattrick slate" — a dotted rail with no explanation is a mystery. */
export function coverLabel(g: GeneralPush, fieldName: string | null): string {
  return g.scope === "city" ? "in city slate" : `in ${fieldName ?? "field"} slate`;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * PROMO CODES — normalised and made unique AT ENTRY, never generated
 *
 * MEASURED on production 2026-09-26: 6,514 promo codes, 71 exact duplicates, 83 case-insensitive
 * collisions, 486 mixing upper and lower case, and five spellings of one refund concept (refund,
 * ref, freeref, ref7, reF). Attribution was already unreadable before anyone split by channel, and
 * splitting doubles the surface.
 *
 * GENERATING THEM WOULD BE WORSE, not better. A promo code only works if it exists in MatchDay,
 * and this planner does not create promo codes — POST /admin/promocodes is a different tool. A
 * generated string would render on the tile, go out to players, and redeem nothing. Free text at
 * least reflects a code somebody actually made.
 *
 * SO: normalise, and refuse the collision that actually breaks attribution. */
export const normalizePromoCode = (raw: string | null | undefined): string | null => {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return v === "" ? null : v;
};

/* ── SHARING A CODE IS ALLOWED, AND SAID OUT LOUD ────────────────────────────────────────────
 * duplicateCodeChannels stood here, returning the channel groups that shared a code so the save
 * could be refused. The refusal is gone (see the note in the save route) and so is it — it had no
 * callers by then anyway, because the code moved from the channel to the push and its
 * Record<channel, code> shape could no longer describe the draft.
 *
 * THE CONSEQUENCE IS REAL AND IT IS NOT A BLOCK. One code on two channels means a redemption
 * cannot be attributed to either, so the editor states that under the field and the operator
 * decides. Campaigns run one code across channels on purpose; the planner's job is to say what
 * that costs, not to forbid it. */

/**
 * The OTHER channels of this match whose pushes carry the same code, by label, in CHANNELS order.
 * Empty when the code is blank or unique to this channel — which is what makes the note absent
 * rather than empty.
 *
 * COMPARED NORMALISED, so "parmer10" beside "PARMER10 " is one code and not two. That is the same
 * rule the save applies, so the note cannot disagree with what is about to be written.
 *
 * OTHER CHANNELS ONLY. Two pushes on the SAME channel sharing a code is the ordinary case — a
 * Thursday and a Saturday send of one campaign — and carries none of the attribution problem.
 */
export function codeAlsoOnChannels(
  draft: PushDraft, channel: ChannelKey, code: string | null | undefined,
): string[] {
  const want = normalizePromoCode(code);
  if (!want) return [];
  const out: string[] = [];
  for (const c of CHANNELS) {
    if (c.key === channel) continue;
    const ch = draft[c.key];
    if (!ch?.on) continue;
    if (ch.rows.some((r) => normalizePromoCode(r.code) === want)) out.push(c.label);
  }
  return out;
}

/** "Klaviyo SMS", "Klaviyo SMS and DM", "Klaviyo SMS, DM and Facebook". */
export function listChannels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/* THE WEEK'S GENERAL PUSHES. Read by DATE RANGE rather than by match, because they belong to no
 * match — that is the whole point of the scope column. A failure here is soft: the page still
 * renders every match push, and a general push that cannot be read is better than a page that
 * cannot.
 *
 * ── AN UNDATED GENERAL PUSH IS READ IN EVERY WEEK ────────────────────────────────────────────
 * `push_at` is nullable and the panel lets you save a general push without a time, so it can and
 * does happen: live row 135, a city push for Atlanta on klaviyo_sms, has no time. It failed BOTH
 * range comparisons — `NULL >= x` and `NULL <= y` are both NULL, never true — so it was invisible
 * in every week of the year at once. There was no week you could go to to find it and give it one.
 *
 * So the filter is "in this week OR undated". The undated ones come back on EVERY week's read,
 * deliberately: an undated push is an unfinished decision, not a thing that happened in a week, and
 * it stays in front of whoever opens the page until it is dated or deleted. They sort last —
 * byPushTime puts a null after every instant — and the card says "No send time" where the time
 * would be.
 *
 * THIS IS FIXED IN THE READ, NOT ON THE PAGE. A page that special-cased nulls it had asked the
 * database to exclude would be a page holding a workaround for a query defect one file away. */
async function fetchGeneralPushes(sb: SupabaseClient, days: { iso: string }[]): Promise<GeneralPush[]> {
  if (days.length === 0) return [];
  const from = `${days[0].iso}T00:00:00`;
  const to = `${days[days.length - 1].iso}T23:59:59.999`;
  const { data, error } = await sb.from("match_promotion_push")
    .select("*").neq("scope", "match")
    .or(`push_at.is.null,and(push_at.gte.${from},push_at.lte.${to})`);
  if (error) return [];
  const out: GeneralPush[] = [];
  for (const r of data ?? []) {
    const scope = String(r.scope);
    if (scope !== "city" && scope !== "field") continue;
    if (!(CHANNEL_KEYS as readonly string[]).includes(String(r.channel))) continue;
    out.push({
      id: r.id as number, scope, channel: r.channel as ChannelKey,
      pushAt: (r.push_at as string | null) ?? null, topic: (r.topic as string | null) ?? null,
      promoCode: (r.promo_code as string | null) ?? null,
      pushedAt: (r.pushed_at as string | null) ?? null, pushedBy: (r.pushed_by as string | null) ?? null,
      city: String(r.scope_city ?? ""), fieldId: (r.scope_field_id as number | null) ?? null,
      audience: (r.audience as string | null) ?? null,
    });
  }
  return out.sort(byPushTime);
}

/* THE TAGS, KEYED ON FIELD. select("*") deliberately, the adminAuth precedent: code deploys before
 * a migration applies, and a named column that does not exist yet turns every load of this page
 * into a 500. An unreadable table degrades to "no tags", which is exactly what is true then. */
/* ── THE TAGS, AT BOTH SCOPES, OUT OF ONE TABLE ───────────────────────────────────────────────
 * 0193 renamed match_promotion_field_tag to promo_tags and gave it a nullable match_id beside the
 * nullable field_id, under a TAG-AWARE check: priority is match-scoped, key_field and starting_11
 * are field-scoped, and the database refuses any other combination. So one read returns both maps
 * and neither can carry a row of the wrong shape.
 *
 * A FAILED READ RETURNS EMPTY MAPS, NOT A THROW. Tags are a courtesy on a planning page; losing
 * them must not cost the operator the week. The node guard asserts the scope split directly rather
 * than through the page, because empty is also what a broken read looks like here. */
async function fetchPromoTags(
  sb: SupabaseClient, fieldIds: number[], matchIds: number[],
): Promise<{ byField: Record<number, string[]>; byMatch: Record<number, string[]> }> {
  const byField: Record<number, string[]> = {};
  const byMatch: Record<number, string[]> = {};
  const fids = [...new Set(fieldIds)];
  const mids = [...new Set(matchIds)];
  /* TWO `in` FILTERS, OR'd, so one round trip covers both scopes. A row is field-scoped or
   * match-scoped and never both, so nothing is double-counted. */
  const chunk = <T,>(xs: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
  };
  const fChunks = fids.length ? chunk(fids, 400) : [[]];
  const mChunks = mids.length ? chunk(mids, 400) : [[]];
  const rounds = Math.max(fChunks.length, mChunks.length);
  for (let i = 0; i < rounds; i++) {
    const f = fChunks[i] ?? [];
    const m = mChunks[i] ?? [];
    if (f.length === 0 && m.length === 0) continue;
    const ors: string[] = [];
    if (f.length) ors.push(`field_id.in.(${f.join(",")})`);
    if (m.length) ors.push(`match_id.in.(${m.join(",")})`);
    const { data, error } = await sb.from("promo_tags").select("*").or(ors.join(","));
    if (error) return { byField: {}, byMatch: {} };
    for (const r of data ?? []) {
      const tag = String(r.tag);
      if (r.match_id != null) {
        const k = Number(r.match_id);
        (byMatch[k] ?? (byMatch[k] = [])).push(tag);
      } else if (r.field_id != null) {
        const k = Number(r.field_id);
        (byField[k] ?? (byField[k] = [])).push(tag);
      }
    }
  }
  return { byField, byMatch };
}

