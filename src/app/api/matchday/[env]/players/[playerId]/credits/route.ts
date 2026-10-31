// Phase 27 — the credit ADJUSTMENT route. The only endpoint in Clubhouse that moves money into or
// out of a player's account, and it is built accordingly.
//
// GET  — the live balance + whether this caller may change it (drives the control, never gates it).
// POST — apply ONE adjustment: { deltaCents, expectedBeforeCents, reason }.
//
// WHAT PART 0 PROVED (see docs/matchday-api-facts.md):
//   • `creditAmount` is CENTS — 22 of 31 non-zero production balances are not multiples of 100.
//   • The write is PUT /admin/players/{id}/profile { creditAmount } and is an ABSOLUTE SET.
//     Retool sends only that one key, which is why PUT here has PATCH semantics like every other
//     PUT in this API — the diff IS the body, and nothing else on the profile is touched.
//
// THE FIVE RULES THIS ROUTE EXISTS TO ENFORCE:
//  1. EDIT CREDITS, read fresh from the database, and NOT implied by Match Ops (creditsAuth).
//     Checked here before any MatchDay call, and again inside apiWrite's unbypassable chokepoint.
//  2. THE CLIENT NEVER SENDS AN ABSOLUTE BALANCE. It sends a DELTA. The absolute value is computed
//     HERE from a fresh server-side read, so a stale or tampered screen cannot set a balance.
//  3. THE RACE IS CHECKED. Re-read immediately before writing; if the balance moved since the
//     screen was drawn, ABORT and report the new figure. Never re-base and continue.
//  4. ONE ATTEMPT. No retry, ever — if the API were a delta a retry would be a second grant, and
//     even for an absolute set a retry is an unnecessary second money movement.
//  5. EVERY change through recordWrite into change_log with before, after, delta and the REASON —
//     and the player ID only. Never a name, phone or email.

import { authenticateCredits } from "@/lib/creditsAuth";
import { apiGet, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { applyCreditAdjustment, balanceOf, creditErrorAnswer } from "@/lib/creditWrite";
import { CONFINED_CITY_ERROR, playerCityAllowed } from "@/lib/cityConfinement";
import { hasPlayedInCity } from "@/lib/playerCityScope";
import { cityNameFor } from "@/lib/cityScope";
import { makeServerClient } from "@/lib/supabaseServer";
import { MAX_ADJUSTMENT_CENTS, fmtUsd } from "@/lib/creditsModel";
import { DRAFT_ACTION_SOURCE } from "@/lib/aiDraftAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

export async function GET(req: Request, ctx: { params: Promise<{ env: string; playerId: string }> }) {
  // The READ is gated on the same grant as the write. A balance is not secret, but there is no
  // reason to surface a money surface to someone who can never use it.
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, playerId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(playerId)) return Response.json({ error: "playerId must be numeric" }, { status: 400 });
  try {
    const p = await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`);
    // REFUSED BY ID, FROM THE SERVER — not by a list that happened not to offer this player.
    /* THE PLAYED-IN HALF OF THE BOUNDARY, resolved against the mirror. The payload above is
     * GET /admin/players/{id} and carries no match history, so the union's second branch cannot be
     * answered from it. Asked only when the account is confined: an unconfined caller is allowed
     * by the first line of playerCityAllowed and must not pay for a query to prove it. */
    const playedInScopeP = auth.confinedCity
      ? await hasPlayedInCity(makeServerClient(), cityNameFor(auth.confinedCity) ?? "", Number(playerId))
      : false;
    if (!playerCityAllowed(auth.confinedCity, p, playedInScopeP)) {
      console.warn(`[credits] 403: ${auth.email} (confined to ${auth.confinedCity}) read player ${playerId}`);
      return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    }
    return Response.json({ playerId: Number(playerId), balanceCents: balanceOf(p), canEditCredits: true });
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; playerId: string }> }) {
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, playerId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(playerId)) return Response.json({ error: "playerId must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    { deltaCents?: unknown; expectedBeforeCents?: unknown; reason?: unknown; source?: unknown } | null;
  if (!body) return Response.json({ error: "body required" }, { status: 400 });

  const delta = Number(body.deltaCents);
  const expected = Number(body.expectedBeforeCents);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  // RE-VALIDATED SERVER-SIDE. The UI refuses all of these too, but a greyed button is a courtesy
  // and this is the control. Every one of these returns BEFORE any MatchDay call.
  if (!Number.isInteger(delta) || delta === 0) return Response.json({ error: "deltaCents must be a non-zero integer number of cents" }, { status: 400 });
  if (!Number.isInteger(expected)) return Response.json({ error: "expectedBeforeCents must be an integer number of cents" }, { status: 400 });
  if (Math.abs(delta) > MAX_ADJUSTMENT_CENTS) {
    return Response.json({ error: `${fmtUsd(Math.abs(delta))} is over the ${fmtUsd(MAX_ADJUSTMENT_CENTS)} single-adjustment limit.` }, { status: 400 });
  }
  if (reason.length < 3) return Response.json({ error: "A reason is required and is written to the change log." }, { status: 400 });

  /* THE PLAYED-IN HALF OF THE BOUNDARY, resolved against the mirror, on the same read the race check
   * uses, so a confined account cannot adjust a player outside its city even by posting the id
   * directly. Asked only when the account is confined. */
  const boundary = async (player: Record<string, unknown>): Promise<string | null> => {
    const playedInScopeP = auth.confinedCity
      ? await hasPlayedInCity(makeServerClient(), cityNameFor(auth.confinedCity) ?? "", Number(playerId))
      : false;
    if (playerCityAllowed(auth.confinedCity, player, playedInScopeP)) return null;
    console.warn(`[credits] 403: ${auth.email} (confined to ${auth.confinedCity}) attempted an adjustment on player ${playerId}`);
    return CONFINED_CITY_ERROR;
  };
  // The write itself, with its race check and recordWrite, lives in src/lib/creditWrite.ts.
  const r = await applyCreditAdjustment({
    env, playerId, deltaCents: delta, expectedBeforeCents: expected, reason,
    source: body.source === DRAFT_ACTION_SOURCE ? DRAFT_ACTION_SOURCE : "Player Lookup · credits",
    actor: { email: auth.email, userId: auth.appUserId }, boundary,
  });
  return Response.json(r.json, { status: r.status });
}

const errToResponse = (e: unknown): Response => {
  const r = creditErrorAnswer(e);
  return Response.json(r.json, { status: r.status });
};
