// Promo Codes — EDIT (Phase 18d). A REAL production write. Same discipline as create: gated on
// MANAGE_PROMOS (a caller without it produces ZERO outbound requests), host-guarded through
// apiWrite, single-shot with no retry, and logged through recordWrite() into change_log.
//
//   PATCH /admin/promocodes/{id}   — confirmed from the Retool export (updateFuturePromocode)
//
// THE DIFF IS THE BODY, with three exceptions the server requires — see promoEditModel.ts:
//   1. discountValue implies discountType     2. either date implies both
//   3. a scope switch DELETES the other scopes' keys
// Those live in the pure model so the route, the screen and the node gate share one copy.
//
// IGNORED-AFTER-REDEMPTION is UNKNOWN for this endpoint: the Retool DTO has no branch on
// usageCount, so nothing here can say which fields a redeemed code will accept. We therefore do
// NOT pre-emptively disable anything. Instead every sent key is compared against a RE-READ and
// reported per field, so a silently-ignored field becomes visible the first time it happens.
import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { getMatchdayApiClient } from "@/lib/matchdayApi";
import {
  apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import type { DiscountType, TargetMatchType, TargetUserType } from "@/lib/promoModel";
import { promoDiff, verifyPromoWrite, type PromoEditable } from "@/lib/promoEditModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const;
const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const WHO: TargetUserType[] = ["ALL_USERS", "NEW_USERS", "CHURN_USERS", "SPECIFIC_USERS"];
const WHICH: TargetMatchType[] = ["ALL_MATCHES", "TOTAL_USAGE", "TIME_PERIOD", "SPECIFIC_FIELDS", "SPECIFIC_MATCHES"];
const ints = (a: unknown): number[] => (Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : []);

type EditBody = {
  after?: Partial<PromoEditable> & { value?: number | string };
  saveId?: string;
};

// Normalise a raw detail payload into the editable shape, in WIRE units.
function toEditable(raw: Record<string, unknown>): PromoEditable {
  return {
    code: String(raw.code ?? ""),
    startDateUtc: String(raw.startDateUtc ?? ""),
    endDateUtc: String(raw.endDateUtc ?? ""),
    discountType: (raw.discountType === "USD" ? "USD" : "PERCENT") as DiscountType,
    discountValue: Number(raw.discountValue ?? 0),
    numberOfUsesPerUser: Number(raw.numberOfUsesPerUser ?? 0),
    targetUserType: (WHO.includes(raw.targetUserType as TargetUserType) ? raw.targetUserType : "ALL_USERS") as TargetUserType,
    targetMatchType: (WHICH.includes(raw.targetMatchType as TargetMatchType) ? raw.targetMatchType : "ALL_MATCHES") as TargetMatchType,
    matchTimePeriodStart: (raw.matchTimePeriodStart as string | null) ?? null,
    matchTimePeriodEnd: (raw.matchTimePeriodEnd as string | null) ?? null,
    userIDs: ints((raw.userPromocodes as Array<{ userId?: number }> | undefined)?.map((u) => u.userId)),
    fieldIDs: ints((raw.fieldPromocodes as Array<{ fieldId?: number }> | undefined)?.map((f) => f.fieldId)),
    matchIDs: ints((raw.matchPromocodes as Array<{ matchId?: number }> | undefined)?.map((m) => m.matchId)),
  };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateCapability(req, "managePromos");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return Response.json({ error: "A numeric promo id is required." }, { status: 400 });

  const b = (await req.json().catch(() => null)) as EditBody | null;
  if (!b?.after) return Response.json({ error: "body required" }, { status: 400 });

  // MANAGE PROMOS — BEFORE any MatchDay call, so a caller without it produces no outbound
  // request at all. apiWrite re-checks with requires:"promos" as the unbypassable chokepoint.
  if (!auth.canManagePromos) {
    console.warn(`[manage-promos] 403: ${auth.email} attempted edit of promo ${id} without MANAGE PROMOS`);
    return Response.json({ error: "You do not hold MANAGE PROMOS. Editing a promo code requires it." }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canManagePromos: auth.canManagePromos, email: auth.email, userId: auth.appUserId };

  const client = getMatchdayApiClient();
  const readRaw = async (): Promise<Record<string, unknown>> =>
    (await client.get<Record<string, unknown>>(`/admin/promocodes/${id}`)) ?? {};

  try {
    const beforeRaw = await readRaw();
    if (!beforeRaw || beforeRaw.id == null) return Response.json({ error: `Promo ${id} was not found.` }, { status: 404 });
    const before = toEditable(beforeRaw);

    // The pending state, validated. Anything absent falls back to the CURRENT value, so an
    // omitted field can never be read as "clear it" — clearing a box is not a change.
    const a = b.after;
    const after: PromoEditable = {
      ...before,
      ...(a.code !== undefined ? { code: String(a.code).trim() } : {}),
      ...(a.startDateUtc !== undefined ? { startDateUtc: String(a.startDateUtc) } : {}),
      ...(a.endDateUtc !== undefined ? { endDateUtc: String(a.endDateUtc) } : {}),
      ...(a.discountType !== undefined ? { discountType: (a.discountType === "USD" ? "USD" : "PERCENT") as DiscountType } : {}),
      ...(a.discountValue !== undefined ? { discountValue: Math.round(Number(a.discountValue)) } : {}),
      ...(a.numberOfUsesPerUser !== undefined ? { numberOfUsesPerUser: Math.floor(Number(a.numberOfUsesPerUser)) } : {}),
      ...(a.targetUserType !== undefined ? { targetUserType: a.targetUserType } : {}),
      ...(a.targetMatchType !== undefined ? { targetMatchType: a.targetMatchType } : {}),
      ...(a.matchTimePeriodStart !== undefined ? { matchTimePeriodStart: a.matchTimePeriodStart } : {}),
      ...(a.matchTimePeriodEnd !== undefined ? { matchTimePeriodEnd: a.matchTimePeriodEnd } : {}),
      ...(a.userIDs !== undefined ? { userIDs: ints(a.userIDs) } : {}),
      ...(a.fieldIDs !== undefined ? { fieldIDs: ints(a.fieldIDs) } : {}),
      ...(a.matchIDs !== undefined ? { matchIDs: ints(a.matchIDs) } : {}),
    };

    if (!after.code) return Response.json({ error: "A code is required." }, { status: 400 });
    if (!WHO.includes(after.targetUserType)) return Response.json({ error: `Unknown audience ${after.targetUserType}.` }, { status: 400 });
    if (!WHICH.includes(after.targetMatchType)) return Response.json({ error: `Unknown scope ${after.targetMatchType}.` }, { status: 400 });
    if (!Number.isFinite(after.discountValue) || after.discountValue <= 0) return Response.json({ error: "A value greater than 0 is required." }, { status: 400 });
    if (after.discountType === "PERCENT" && after.discountValue > 100) return Response.json({ error: "A percent discount cannot exceed 100%." }, { status: 400 });
    if (!isoRe.test(after.startDateUtc) || !isoRe.test(after.endDateUtc)) return Response.json({ error: "start and end must be UTC instants." }, { status: 400 });
    if (after.endDateUtc <= after.startDateUtc) return Response.json({ error: "The end must be after the start." }, { status: 400 });
    if (!Number.isFinite(after.numberOfUsesPerUser) || after.numberOfUsesPerUser < 1) return Response.json({ error: "Uses must be at least 1." }, { status: 400 });
    if (after.targetMatchType === "TIME_PERIOD") {
      if (!isoRe.test(after.matchTimePeriodStart ?? "") || !isoRe.test(after.matchTimePeriodEnd ?? "")) {
        return Response.json({ error: "The match time period needs a start and end." }, { status: 400 });
      }
      if ((after.matchTimePeriodEnd ?? "") <= (after.matchTimePeriodStart ?? "")) {
        return Response.json({ error: "The match period end must be after its start." }, { status: 400 });
      }
    }
    if (after.targetMatchType === "SPECIFIC_FIELDS" && (after.fieldIDs?.length ?? 0) === 0) return Response.json({ error: "Pick at least one field for a Specific Fields code." }, { status: 400 });
    if (after.targetMatchType === "SPECIFIC_MATCHES" && (after.matchIDs?.length ?? 0) === 0) return Response.json({ error: "Pick at least one match for a Specific Matches code." }, { status: 400 });
    if (after.targetUserType === "SPECIFIC_USERS" && (after.userIDs?.length ?? 0) === 0) return Response.json({ error: "Pick at least one user for a Specific Users code." }, { status: 400 });

    const diff = promoDiff(before, after);
    if (Object.keys(diff.body).length === 0) {
      return Response.json({ ok: true, noop: true, message: "Nothing changed — no request was sent." });
    }

    // change_log: the code id and the fields that moved. NEVER the code's redeemers.
    const changes: Change[] = Object.keys(diff.body).map((k) => ({
      key: k,
      field: k,
      before: (before as unknown as Record<string, unknown>)[k] ?? null,
      after: diff.body[k] ?? null,
    })) as Change[];

    let afterRaw: Record<string, unknown> = {};
    const { result, error, outcome, logged } = await recordWrite(
      {
        env: ENV, source: "Promo Codes", actorName: auth.email, actorEmail: auth.email,
        saveId: b.saveId || randomUUID(), matchId: null, matchName: before.code,
        method: "PATCH", path: `/admin/promocodes/${id}`, body: diff.body,
        keys: Object.keys(diff.body), label: (k) => k,
        applied: (_bef, aft) => { afterRaw = aft as Record<string, unknown>; return true; },
        changes,
      },
      {
        readResource: async () => { const r = await readRaw(); return r; },
        write: () => apiWrite(ENV, "PATCH", `/admin/promocodes/${id}`, diff.body, actor, "promos"),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    // PER-FIELD read-back. A 2xx is not proof; this is what turns a silently-ignored field into
    // a visible NOT APPLIED the first time it happens.
    const readBack = toEditable(afterRaw.id != null ? afterRaw : await readRaw());
    const v = verifyPromoWrite(diff.body, readBack as unknown as Record<string, unknown>);

    return Response.json({
      ok: true, result, logRecorded: logged,
      outcome: v.outcome, status: v.outcome === "landed" ? "LANDED" : "NOT APPLIED",
      fields: v.fields, notApplied: v.notApplied,
      sentKeys: Object.keys(diff.body), pairedIn: diff.pairedIn, removed: diff.removed,
      serverOutcome: outcome,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true, status: "UNKNOWN" }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message, status: "FAILED" }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
