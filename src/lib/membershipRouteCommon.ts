/* THE PARTS ALL THREE MEMBERSHIP ROUTES SHARE. Server-only.
 *
 * Extracted so add / price / end cannot drift on the things that must not drift: the grant check,
 * the confinement check against the server's own copy of the player, how a membership is read off
 * a player payload, and how the two reads are turned into a verdict.
 */
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { readStripeSubscription } from "./stripePayments";
import { CONFINED_CITY_ERROR, playerCityAllowed } from "./cityConfinement";
import { hasPlayedInCity } from "./playerCityScope";
import { cityNameFor } from "./cityScope";
import { makeServerClient } from "./supabaseServer";
import type { MemFacts, WriteVerdict } from "./membershipAdminModel";

export const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* ── WHICH SUBSCRIPTION IS "THE" ONE ─────────────────────────────────────────────────────────
 * A player can carry several rows. The live one is whatever is NOT CANCELED — the API's own
 * add-block keys on `status in (ACTIVE, ADDED_FROM_ADMIN)`, so that pair is what "has a membership"
 * means. Falls back to the most recent CANCELED row so a closed membership can still be shown and
 * reopened rather than reading as "never a member". */
export function membershipOf(playerRaw: Record<string, unknown>): MemFacts | null {
  const d = (playerRaw && typeof playerRaw === "object" && "data" in playerRaw
    ? (playerRaw.data as Record<string, unknown>) : playerRaw) ?? {};
  const rows = Array.isArray(d.userSubscriptions) ? (d.userSubscriptions as Record<string, unknown>[]) : [];
  if (rows.length === 0) return null;
  const facts = (r: Record<string, unknown>): MemFacts => ({
    id: num(r.id),
    statusRaw: str(r.status),
    stripeSubscriptionId: str(r.stripeSubscriptionId),
    canceledAt: str(r.canceledAt),
    price: num(r.amount),
  });
  const live = rows.find((r) => {
    const s = (str(r.status) ?? "").toUpperCase();
    return s === "ACTIVE" || s === "ADDED_FROM_ADMIN";
  });
  if (live) return facts(live);
  const sorted = [...rows].sort((a, b) => (num(b.id) ?? 0) - (num(a.id) ?? 0));
  return facts(sorted[0]);
}

/** The one subscription this write is keyed on, by its numeric id. */
export function membershipById(playerRaw: Record<string, unknown>, id: number): MemFacts | null {
  const d = (playerRaw && typeof playerRaw === "object" && "data" in playerRaw
    ? (playerRaw.data as Record<string, unknown>) : playerRaw) ?? {};
  const rows = Array.isArray(d.userSubscriptions) ? (d.userSubscriptions as Record<string, unknown>[]) : [];
  const r = rows.find((x) => num(x.id) === id);
  if (!r) return null;
  return {
    id: num(r.id), statusRaw: str(r.status), stripeSubscriptionId: str(r.stripeSubscriptionId),
    canceledAt: str(r.canceledAt), price: num(r.amount),
  };
}

/** CONFINEMENT ON THE SERVER'S OWN COPY. The id can be sent directly, so a confined operator has to
 *  be refused here and not merely find the control absent from a page. */
export async function confinementRefusal(
  env: MatchdayEnv, confinedCity: string | null, playerId: number, playerRaw: Record<string, unknown>,
): Promise<string | null> {
  void env;
  const playedInScope = confinedCity
    ? await hasPlayedInCity(makeServerClient(), cityNameFor(confinedCity) ?? "", playerId)
    : false;
  return playerCityAllowed(confinedCity, playerRaw, playedInScope) ? null : CONFINED_CITY_ERROR;
}

export const readPlayer = (env: MatchdayEnv, playerId: number) =>
  apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`);

/* ── THE TWO READS, TURNED INTO TWO FACTS ────────────────────────────────────────────────────
 * The MatchDay row and the Stripe subscription are read SEPARATELY and reported SEPARATELY,
 * because MatchDay swallows a Stripe failure and updates its row regardless. A single "did it
 * work" would have to pick one of them and would be wrong half the time it mattered.
 *
 * `stripeMoved` is the caller's test — cancelled, or carrying the new amount — because what counts
 * as moved differs per action and neither is "the row changed". */
export async function verdictFrom(
  rowMoved: boolean,
  subscriptionId: string | null,
  stripeMoved: (s: Awaited<ReturnType<typeof readStripeSubscription>>) => boolean,
): Promise<WriteVerdict> {
  const row: WriteVerdict["row"] = rowMoved ? "moved" : "unchanged";
  if (!subscriptionId) return { row, stripe: "absent", subscriptionId: null };
  const s = await readStripeSubscription(subscriptionId);
  if (s.error) return { row, stripe: "unreadable", subscriptionId };
  // NOT FOUND IS AN ABSENCE, NOT A FAILURE. Stripe purges some cancelled ids; saying "Stripe did
  // not move" about an object it does not hold would be a false alarm on a write that worked.
  if (!s.found) return { row, stripe: "absent", subscriptionId };
  return { row, stripe: stripeMoved(s) ? "moved" : "unchanged", subscriptionId };
}
