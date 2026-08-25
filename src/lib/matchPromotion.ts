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

export type PromoPlan = {
  matchApiId: number;
  channels: Record<ChannelKey, boolean>;
  pushAt: string | null; // ISO instant, or null = needs a decision
  promoCode: string | null;
  comment: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

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
  /** planned | needs-decision | none — derived once here so no view re-derives it. */
  state: "planned" | "needs-decision" | "none";
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
  /** False when match_promotion_plan is not in the database yet — every match reads as "no plan". */
  planTableReady: boolean;
  generatedAt: string;
};

const emptyChannels = (): Record<ChannelKey, boolean> =>
  Object.fromEntries(CHANNEL_KEYS.map((k) => [k, false])) as Record<ChannelKey, boolean>;

/** Any channel lit. This — not the presence of the row — is what separates "no plan" from a plan. */
export function anyChannel(p: PromoPlan | null): boolean {
  return !!p && CHANNEL_KEYS.some((k) => p.channels[k]);
}

export function stateOf(p: PromoPlan | null): PromoMatch["state"] {
  if (!p) return "none";
  if (p.pushAt) return "planned";
  return anyChannel(p) ? "needs-decision" : "none";
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
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const { data, error } = await sb.from("match_promotion_plan").select("*").in("match_api_id", chunk);
    if (error) { ready = false; break; }
    for (const r of data ?? []) {
      const channels = emptyChannels();
      for (const k of CHANNEL_KEYS) channels[k] = r[k] === true;
      plans.set(r.match_api_id, {
        matchApiId: r.match_api_id,
        channels,
        pushAt: r.push_at ?? null,
        promoCode: r.promo_code ?? null,
        comment: r.comment ?? null,
        updatedBy: r.updated_by ?? null,
        updatedAt: r.updated_at ?? null,
      });
    }
  }
  return { plans, ready };
}

export async function fetchPromoWeek(
  sb: SupabaseClient,
  now: Date,
  weekRef: Date = now,
): Promise<PromoWeek> {
  const week = await fetchVeoWeek(sb, now, weekRef);
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
    return { ...m, plan, state: stateOf(plan), newFlag: newnessOf(m, slate) };
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

/** One city-day. `planned` iff any match that day has a push instant on it. */
export function coverageStateOf(dayMatches: PromoMatch[]): CoverageState {
  if (dayMatches.length === 0) return "none";
  return dayMatches.some((m) => m.plan?.pushAt) ? "planned" : "open";
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
