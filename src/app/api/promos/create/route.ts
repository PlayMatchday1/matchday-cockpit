// Promo Codes — CREATE (Phase 18b). A REAL production write. Gated on MANAGE_PROMOS (a
// caller without it produces ZERO outbound requests), host-guarded, and logged through
// recordWrite() into change_log — the same discipline as every other production write.
//
// The request body is built SERVER-SIDE from validated fields; the client never sends a path.
//   POST /admin/promocodes { code, startDateUtc, endDateUtc, discountType, discountValue,
//                            numberOfUsesPerUser, targetUserType, targetMatchType }
// discountValue is stored in CENTS for USD; the client sends dollars and we ×100 here so the
// cents rule lives in one place. Code is stored EXACTLY as typed — no normalisation (7i/8c).
// This phase supports the non-picker audiences/scopes (ALL/NEW/CHURN, ALL_MATCHES/TOTAL_USAGE);
// SPECIFIC_* and TIME_PERIOD need selectors and are rejected with a clear message.
import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { getMatchdayApiClient } from "@/lib/matchdayApi";
import {
  apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { discountLabel, type DiscountType, type PromoRow, type TargetMatchType, type TargetUserType } from "@/lib/promoModel";

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

  const client = getMatchdayApiClient();
  // read-back by exact code (substring search filtered to equality; includes soft-deleted). A
  // high limit so the exact code is in the fetched set for realistic full codes; if the substring
  // set is larger, an exact hit is still definitive, and a miss falls through to the server check.
  const readResource = async (): Promise<Record<string, unknown>> => {
    const r = await client.get<{ data?: PromoRow[] }>("/api/v1/admin/promocodes", { code, limit: 300, page: 1 }).catch(() => ({ data: [] as PromoRow[] }));
    const hit = (r.data ?? []).find((x) => x.code.toLowerCase() === code.toLowerCase());
    return { exists: !!hit, id: hit?.id ?? null };
  };

  try {
    // pre-check: refuse a CONFIRMED duplicate before writing. A non-confirmation (the exact code
    // wasn't in the fetched set) is NOT treated as free — we proceed and let the server reject.
    const before = await readResource();
    if (before.exists) return Response.json({ error: `${code} already exists (ID ${before.id}). Pick another.`, duplicate: true }, { status: 409 });

    const changes: Change[] = [{ key: "create", field: "Create promo code", before: null, after: `${code} — ${discountLabel({ discountType, discountValue })}, ${who} · ${which}` }];
    const { result, error, outcome, logged } = await recordWrite(
      {
        env: ENV, source: "Promo Codes", actorName: auth.email, actorEmail: auth.email,
        saveId: b.saveId || randomUUID(), matchId: null, matchName: code,
        method: "POST", path: "/admin/promocodes", body, keys: [], label: (k) => k,
        applied: (bef, aft) => aft.exists === true && bef.exists !== true, changes,
      },
      { readResource, write: () => apiWrite(ENV, "POST", "/admin/promocodes", body, actor, "promos"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);
    return Response.json({ ok: true, result, outcome, logRecorded: logged });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
