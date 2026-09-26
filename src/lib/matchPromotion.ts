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

/** The channel's code: the first non-empty one on its rows. The UI writes them all alike. */
export function codeFor(plan: PromoPlan | null, channel: ChannelKey): string | null {
  for (const p of pushesFor(plan, channel)) if (p.promoCode?.trim()) return p.promoCode.trim();
  return null;
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
export type DraftRow = { key: string; id?: number; pushAt: string | null; topic: string };
export type DraftChannel = { on: boolean; code: string; rows: DraftRow[] };
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
      code: codeFor(plan, k) ?? "",
      rows: rows.map((p) => ({ key: `p-${p.id}`, id: p.id, pushAt: p.pushAt, topic: p.topic ?? "" })),
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
    const rows = c.rows.length > 0 ? c.rows : [{ key: "implicit", pushAt: null, topic: "" } as DraftRow];
    for (const r of rows) {
      out.push({ id: r.id, channel: k, at: r.pushAt, topic: r.topic, promoCode: c.code });
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
    if (c.code.trim()) codes++;
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
 * appear in the prior week's slate for its city.
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
export type NewFlag = "field" | "day" | "time";

/** Shown on the badge. The order of the keys is the precedence order below. */
export const NEW_FLAG_LABEL: Record<NewFlag, string> = {
  field: "NEW FIELD",
  day: "NEW DAY",
  time: "NEW TIME",
};

/** One city's prior-week slate, indexed for the three nested tests. */
export type CitySlate = { venues: Set<string>; venueDay: Set<string>; venueDayTime: Set<string> };
export type PriorSlate = Map<string, CitySlate>;

/** Anything with the four fields the comparison reads. VeoMatch satisfies it structurally. */
export type SlotLike = Pick<VeoMatch, "city" | "venue" | "dayIdx" | "minutes">;

export function buildPriorSlate(prior: SlotLike[]): PriorSlate {
  const out: PriorSlate = new Map();
  for (const m of prior) {
    let c = out.get(m.city);
    if (!c) { c = { venues: new Set(), venueDay: new Set(), venueDayTime: new Set() }; out.set(m.city, c); }
    c.venues.add(m.venue);
    c.venueDay.add(`${m.venue}|${m.dayIdx}`);
    c.venueDayTime.add(`${m.venue}|${m.dayIdx}|${m.minutes}`);
  }
  return out;
}

/**
 * The most significant thing that is new about this slot, or null.
 *
 * PRECEDENCE IS FIELD, THEN DAY, THEN TIME, and it is a nesting rather than a ranking: a new field
 * has a new day and a new time by definition, so reporting the day would be true and useless. Only
 * the outermost thing that changed is worth a badge.
 *
 * A CITY ABSENT FROM THE PRIOR SLATE IS ALL-NEW. Warsaw's first week is the live case: no prior
 * slate at all, so every field on it is a new field.
 */
export function newnessOf(m: SlotLike, slate: PriorSlate): NewFlag | null {
  const c = slate.get(m.city);
  if (!c) return "field";
  if (!c.venues.has(m.venue)) return "field";
  if (!c.venueDay.has(`${m.venue}|${m.dayIdx}`)) return "day";
  if (!c.venueDayTime.has(`${m.venue}|${m.dayIdx}|${m.minutes}`)) return "time";
  return null;
}

/** A match plus whatever plan exists for it. `plan` is null when no row has ever been written. */
export type PromoMatch = VeoMatch & {
  plan: PromoPlan | null;
  /* planned | needs-decision | none | cancelled — derived once here so no view re-derives it.
   * CANCELLED IS ITS OWN STATE, NOT A VARIANT OF "none". Nothing was missed; the match was called
   * off, so it is excluded from the no-plan count and totalled separately per city. */
  state: "planned" | "needs-decision" | "none" | "cancelled";
  /** The most significant thing new about this slot against the prior week's slate, or null. */
  newFlag: NewFlag | null;
};

export type PromoWeek = {
  weekStart: string;
  /** The Monday of the week the NEW test compared against — printed on the page so the rule is
   *  legible without asking, and so a wrong week is visible rather than silent. */
  priorWeekStart: string;
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

  /* THE PRIOR WEEK — the same seven weekdays one week earlier, and its SLATE rather than its play.
   * Built from the Monday of the week on screen, so paging back a week moves the comparison with
   * it. `includeCancelled` is the whole point (see newnessOf). */
  const [y, mo, d] = week.weekStart.split("-").map(Number);
  const priorRef = new Date(y, mo - 1, d - 7);
  const prior = await fetchVeoWeek(sb, now, priorRef, null, true);
  const slate = buildPriorSlate(prior.matches);

  const matches: PromoMatch[] = week.matches.map((m) => {
    const plan = plans.get(m.apiId) ?? null;
    return { ...m, plan, state: stateOf(plan, m.isCancelled), newFlag: newnessOf(m, slate) };
  });
  // City, then day, then time. The grid renders in this order and so does the worklist fallback.
  matches.sort((a, b) => a.city.localeCompare(b.city) || a.dayIdx - b.dayIdx || a.minutes - b.minutes);

  return {
    weekStart: week.weekStart,
    priorWeekStart: prior.weekStart,
    days: week.days,
    matches,
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
