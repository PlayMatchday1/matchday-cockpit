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
  { key: "wa", short: "WA", label: "WhatsApp push" },
  { key: "match_chat", short: "MC", label: "Match chat" },
  { key: "fb", short: "FB", label: "Facebook push" },
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

/** A match plus whatever plan exists for it. `plan` is null when no row has ever been written. */
export type PromoMatch = VeoMatch & {
  plan: PromoPlan | null;
  /** planned | needs-decision | none — derived once here so no view re-derives it. */
  state: "planned" | "needs-decision" | "none";
};

export type PromoWeek = {
  weekStart: string;
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

  const matches: PromoMatch[] = week.matches.map((m) => {
    const plan = plans.get(m.apiId) ?? null;
    return { ...m, plan, state: stateOf(plan) };
  });
  // City, then day, then time. The grid renders in this order and so does the worklist fallback.
  matches.sort((a, b) => a.city.localeCompare(b.city) || a.dayIdx - b.dayIdx || a.minutes - b.minutes);

  return {
    weekStart: week.weekStart,
    days: week.days,
    matches,
    planTableReady: ready,
    generatedAt: now.toISOString(),
  };
}

export { weekMonday };
