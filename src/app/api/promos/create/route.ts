// Promo Codes — CREATE (Phase 18b). A REAL production write. Gated on MANAGE_PROMOS (a
// caller without it produces ZERO outbound requests), host-guarded, and logged through
// recordWrite() into change_log — the same discipline as every other production write.
//
// The request body is built SERVER-SIDE from validated fields; the client never sends a path.
//   POST /admin/promocodes { code, startDateUtc, endDateUtc, discountType, discountValue,
//                            numberOfUsesPerUser, targetUserType, targetMatchType }
// discountValue is stored in CENTS for USD; the client sends dollars and we ×100 here so the
// cents rule lives in one place. Code is stored EXACTLY as typed — no normalisation (7i/8c).
// ── A CORRECTION TO THIS HEADER ───────────────────────────────────────────────────────────────
// It read: "This phase supports the non-picker audiences/scopes (ALL/NEW/CHURN,
// ALL_MATCHES/TOTAL_USAGE); SPECIFIC_* and TIME_PERIOD need selectors and are rejected with a
// clear message." That stopped being true when the pickers landed. WHO_ALLOWED carries
// SPECIFIC_USERS and WHICH_ALLOWED carries all five targetMatchType values, selectors and all.
//
// THE TWO AXES ARE INDEPENDENT, and the body below is where that is decided: targetUserType and
// targetMatchType are two keys assembled by two separate spreads, so SPECIFIC_USERS and
// SPECIFIC_FIELDS travel together in one code. The only exclusivity is INSIDE targetMatchType,
// whose five values are one enum — a code is total-capped OR pinned to fields, never both.
//
// A PROMO CARRIES NO CITY. The endpoint takes no city field, so a code is redeemable estate-wide
// unless it is pinned to specific fields or matches. A confined operator creating one is
// therefore creating an estate-wide code, knowingly: see cityConfinement.ts's /api/promos/create
// entry for the ruling. The change_log row is the only record of who made it.
import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { DRAFT_ACTION_SOURCE } from "@/lib/aiDraftAction";
import { createPromoWrite } from "@/lib/promoWrite";
import { discountLabel, type DiscountType, type TargetMatchType, type TargetUserType } from "@/lib/promoModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const; // promos are managed on production (this replaces Retool)
const WHO_ALLOWED: TargetUserType[] = ["ALL_USERS", "NEW_USERS", "CHURN_USERS", "SPECIFIC_USERS"];
const WHICH_ALLOWED: TargetMatchType[] = ["ALL_MATCHES", "TOTAL_USAGE", "TIME_PERIOD", "SPECIFIC_FIELDS", "SPECIFIC_MATCHES"];

type CreateBody = {
  code?: string; discountType?: DiscountType; value?: number | string;
  startDateUtc?: string; endDateUtc?: string; uses?: number | string;
  who?: TargetUserType; which?: TargetMatchType; saveId?: string;
  // scope payloads — only the one matching who/which is read; the rest are ignored (D5)
  userIDs?: number[]; matchIDs?: number[]; fieldIDs?: number[];
  matchTimePeriodStart?: string; matchTimePeriodEnd?: string;
  source?: string;
};
const ints = (a: unknown): number[] => Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : [];

const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "managePromos");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const b = (await req.json().catch(() => null)) as CreateBody | null;
  if (!b) return Response.json({ error: "body required" }, { status: 400 });

  const code = (b.code ?? "").trim();
  if (!code) return Response.json({ error: "A code is required." }, { status: 400 });
  const discountType: DiscountType = b.discountType === "USD" ? "USD" : "PERCENT";
  const value = Number(b.value);
  if (!Number.isFinite(value) || value <= 0) return Response.json({ error: "A value greater than 0 is required." }, { status: 400 });
  if (discountType === "PERCENT" && value > 100) return Response.json({ error: "A percent discount cannot exceed 100%." }, { status: 400 });
  const startDateUtc = String(b.startDateUtc ?? "");
  const endDateUtc = String(b.endDateUtc ?? "");
  if (!isoRe.test(startDateUtc) || !isoRe.test(endDateUtc)) return Response.json({ error: "start and end must be UTC instants." }, { status: 400 });
  if (endDateUtc <= startDateUtc) return Response.json({ error: "The end must be after the start." }, { status: 400 });
  const uses = Math.floor(Number(b.uses));
  if (!Number.isFinite(uses) || uses < 1) return Response.json({ error: "Uses must be at least 1." }, { status: 400 });
  const who: TargetUserType = b.who && WHO_ALLOWED.includes(b.who) ? b.who : "ALL_USERS";
  const which: TargetMatchType = b.which && WHICH_ALLOWED.includes(b.which) ? b.which : "ALL_MATCHES";
  if (b.who && !WHO_ALLOWED.includes(b.who)) return Response.json({ error: `Unknown audience ${b.who}.` }, { status: 400 });
  if (b.which && !WHICH_ALLOWED.includes(b.which)) return Response.json({ error: `Unknown scope ${b.which}.` }, { status: 400 });
  // scope payloads — validate ONLY the one the active scope needs (D5: the rest are dropped)
  const userIDs = ints(b.userIDs), matchIDs = ints(b.matchIDs), fieldIDs = ints(b.fieldIDs);
  if (who === "SPECIFIC_USERS" && userIDs.length === 0) return Response.json({ error: "Pick at least one user for a Specific Users code." }, { status: 400 });
  if (which === "SPECIFIC_MATCHES" && matchIDs.length === 0) return Response.json({ error: "Pick at least one match for a Specific Matches code." }, { status: 400 });
  if (which === "SPECIFIC_FIELDS" && fieldIDs.length === 0) return Response.json({ error: "Pick at least one field for a Specific Fields code." }, { status: 400 });
  let mpStart = "", mpEnd = "";
  if (which === "TIME_PERIOD") {
    mpStart = String(b.matchTimePeriodStart ?? ""); mpEnd = String(b.matchTimePeriodEnd ?? "");
    if (!isoRe.test(mpStart) || !isoRe.test(mpEnd)) return Response.json({ error: "The match time period needs a start and end." }, { status: 400 });
    if (mpEnd <= mpStart) return Response.json({ error: "The match period end must be after its start." }, { status: 400 });
  }

  // MANAGE PROMOS check — BEFORE any MatchDay call. Network-free 403. (apiWrite re-checks with
  // requires:"promos" as the unbypassable chokepoint; this early return keeps the 403 quiet.)
  if (!auth.canManagePromos) {
    console.warn(`[manage-promos] 403: ${auth.email} attempted create "${code}" without MANAGE PROMOS`);
    return Response.json({ error: "You do not hold MANAGE PROMOS. Creating a promo code requires it." }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canManagePromos: auth.canManagePromos, email: auth.email, userId: auth.appUserId };

  const discountValue = discountType === "USD" ? Math.round(value * 100) : value; // USD → cents
  // The diff IS the body — include ONLY the active scope's array/keys, never a stale one (D5).
  const body = {
    code, startDateUtc, endDateUtc, discountType, discountValue, numberOfUsesPerUser: uses, targetUserType: who, targetMatchType: which,
    ...(who === "SPECIFIC_USERS" ? { userIDs } : {}),
    ...(which === "SPECIFIC_FIELDS" ? { fieldIDs } : which === "SPECIFIC_MATCHES" ? { matchIDs } : which === "TIME_PERIOD" ? { matchTimePeriodStart: mpStart, matchTimePeriodEnd: mpEnd } : {}),
  };

  // The write itself, with its duplicate check and recordWrite, lives in src/lib/promoWrite.ts.
  const r = await createPromoWrite({
    env: ENV, code, body, changeAfter: `${code} — ${discountLabel({ discountType, discountValue })}, ${who} · ${which}`,
    source: b.source === DRAFT_ACTION_SOURCE ? DRAFT_ACTION_SOURCE : "Promo Codes", saveId: b.saveId || randomUUID(), actor,
  });
  return Response.json(r.json, { status: r.status });
}
