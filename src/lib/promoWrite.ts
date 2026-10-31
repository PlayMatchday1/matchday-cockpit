// CREATING A PROMO CODE: the duplicate check and the logged POST. The Promo Codes route gates it for a
// person holding MANAGE PROMOS; the auto-send tick calls it with a system actor. The route stays closed
// to the cron secret: only this function is shared. The caller builds and validates the body.

import { getMatchdayApiClient } from "@/lib/matchdayApi";
import {
  apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError,
  ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv, type WriteActor,
} from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import type { PromoRow } from "@/lib/promoModel";
import type { WriteAnswer } from "@/lib/creditWrite";

export async function createPromoWrite(a: {
  env: MatchdayEnv; code: string; body: Record<string, unknown>; changeAfter: string; source: string; saveId: string; actor: WriteActor;
}): Promise<WriteAnswer> {
  const { env, code, body } = a;
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
    // wasn't in the fetched set) is NOT treated as free: we proceed and let the server reject.
    const before = await readResource();
    if (before.exists) return { status: 409, json: { error: `${code} already exists (ID ${before.id}). Pick another.`, duplicate: true } };

    const changes: Change[] = [{ key: "create", field: "Create promo code", before: null, after: a.changeAfter }];
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: a.source, actorName: a.actor.email ?? "unknown", actorEmail: a.actor.email ?? null,
        saveId: a.saveId, matchId: null, matchName: code,
        method: "POST", path: "/admin/promocodes", body, keys: [], label: (k) => k,
        applied: (bef, aft) => aft.exists === true && bef.exists !== true, changes,
      },
      { readResource, write: () => apiWrite(env, "POST", "/admin/promocodes", body, a.actor, "promos"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return promoErrorAnswer(error);
    return { status: 200, json: { ok: true, result, outcome, logRecorded: logged } };
  } catch (e) { return promoErrorAnswer(e); }
}

function promoErrorAnswer(e: unknown): WriteAnswer {
  if (e instanceof NotAuthorizedError) return { status: 403, json: { error: e.message } };
  if (e instanceof AmbiguousWriteError) return { status: 502, json: { error: e.message, ambiguous: true } };
  if (e instanceof ProductionWriteBoltedError) return { status: 503, json: { error: e.message } };
  if (e instanceof DeniedEndpointError) return { status: 403, json: { error: e.message } };
  if (e instanceof DeniedFieldError) return { status: 400, json: { error: e.message } };
  if (e instanceof StageHostGuardError) return { status: 500, json: { error: e.message } };
  if (e instanceof WriteFailedError) return { status: e.status >= 400 && e.status < 600 ? e.status : 400, json: { error: e.message } };
  if (e instanceof StageConfigError) return { status: 500, json: { error: e.message } };
  return { status: 500, json: { error: e instanceof Error ? e.message : String(e) } };
}
