import "server-only";
// MATCH OPS › PUSH NOTIFICATIONS, the server half shared by every /api/pushes/* route. The same gate, config, pacer
// and write pipeline as Offers (src/lib/offersServer.ts): Match Ops access, OFFERS_ENV says which backend, one paced
// read at a time, every write once through recordWrite with the verdict read back from the backend's own answer.
//
// THE BACKEND ROUTES NAMED HERE ARE A PROPOSAL. On 2026-11-06 none of them existed on staging (every /admin/pushes*
// path answered with an HTML page; /admin/offers/page answered). They are listed as UNKNOWN in
// docs/matchday-api-facts.md and this file is the one place to move when the real contract lands. Until then a
// page read says backend: "missing", the page disables what would write, and the list still shows the pushes that
// go with offers (real, from GET /admin/offers/page).
//
// THE FIXTURE (src/lib/pushesFixture.ts) stands in for that backend on a dev server only (PUSHES_FIXTURE=1, never
// on Vercel), so the screens can be driven before the backend exists. It records no change_log row: nothing it does
// reaches a player.

import { randomUUID } from "node:crypto";
import { recordWrite } from "@/lib/changeLog";
import { apiGet, apiWrite, WriteFailedError } from "@/lib/matchdayStageApi";
import { offersLogBody, type Campaign } from "@/lib/offersModel";
import { _offersCfg, _offersPaced, errorText, offersApiWrite, readPlayerLookup, readPushSettings, testPushErrorText, _offersLogStore, type OffersAuth, type Verdict } from "@/lib/offersServer";
import { READS_STOPPED } from "@/lib/offersPacing";
import { testSendOutcome } from "@/lib/offersPush";
import { parseTokens, type AudienceBody, type FoundPlayer, type TokenLookup } from "@/lib/audienceModel";
import { PUSH_ID_SETS, type PushCampaign, type PushCount, type PushResultsData } from "@/lib/pushesModel";
import { fixture } from "@/lib/pushesFixture";

export const PUSHES = "/admin/pushes";
export type Backend = "ready" | "missing";
export const NO_PUSHES_BACKEND = "The Push Notifications backend isn't on this server yet.";

export const fixtureOn = (env: Record<string, string | undefined> = process.env) => env.NODE_ENV !== "production" && !env.VERCEL && env.PUSHES_FIXTURE === "1";

// A route the backend doesn't have: an HTML page (staging), or a 404 with no errorCode (a Nest "Cannot GET").
export function missingRoute(e: unknown): boolean {
  if (e instanceof SyntaxError) return true;
  if (e instanceof WriteFailedError && e.status === 404) { try { return !JSON.parse(e.bodySnippet).errorCode; } catch { return true; } }
  return false;
}
export function pushesErrorText(e: unknown): string {
  if (missingRoute(e)) return NO_PUSHES_BACKEND;
  if (e instanceof Error && e.name === READS_STOPPED) return "The backend just had a problem, so reads have stopped for a moment. Try again in 30 seconds.";
  return errorText(e);
}

// ── READS ────────────────────────────────────────────────────────────────────────────────────────
const paced = _offersPaced;
function pushesGet<T>(path: string): Promise<T> {
  const { env, baseUrl } = _offersCfg();
  return paced(() => apiGet<T>(env, path, undefined, baseUrl));
}
// A read the backend takes as a POST (the count, the sample, the lookup); not a write, so not through recordWrite.
function pushesPost<T>(auth: OffersAuth, path: string, body: unknown): Promise<T> {
  const { env, baseUrl } = _offersCfg();
  return paced(() => apiWrite<T>(env, "POST", path, body, auth.actor, "offers", undefined, undefined, baseUrl));
}

export async function readPushes(): Promise<{ pushes: PushCampaign[]; backend: Backend; error?: string }> {
  if (fixtureOn()) return { pushes: fixture.list(), backend: "ready" };
  try {
    const r = await pushesGet<{ pushes: PushCampaign[] }>(PUSHES);
    return { pushes: Array.isArray(r?.pushes) ? r.pushes : [], backend: "ready" };
  } catch (e) {
    if (missingRoute(e)) return { pushes: [], backend: "missing" };
    return { pushes: [], backend: "missing", error: pushesErrorText(e) };
  }
}
export async function readPush(id: number): Promise<PushCampaign | null> {
  if (fixtureOn()) return fixture.get(id);
  try { return await pushesGet<PushCampaign>(`${PUSHES}/${id}`); }
  catch (e) { if (e instanceof WriteFailedError && e.status === 404) return null; throw e; }
}
export const readPushResults = (id: number): Promise<PushResultsData> => (fixtureOn() ? Promise.resolve(fixture.results(id)) : pushesGet<PushResultsData>(`${PUSHES}/${id}/results`));
export const readPushCount = (auth: OffersAuth, body: AudienceBody): Promise<PushCount> => (fixtureOn() ? Promise.resolve(fixture.count(body)) : pushesPost<PushCount>(auth, `${PUSHES}/audience-count`, body));
export type SamplePlayer = { id: number; name: string | null; city: string | null; allowsPush: boolean; lastPlayed?: string | null };
export const readPushSample = (auth: OffersAuth, body: AudienceBody): Promise<{ players: SamplePlayer[]; total: number }> =>
  fixtureOn() ? Promise.resolve(fixture.sample(body)) : pushesPost<{ players: SamplePlayer[]; total: number }>(auth, `${PUSHES}/audience-sample`, body);
export async function readWeeklyCap(): Promise<number | null> {
  try { return (await readPushSettings()).weeklyCap; } catch (e) { console.error(`[pushes] weekly cap: ${pushesErrorText(e)}`); return null; }
}

// EXACT PLAYERS: ids, emails and phones. The pushes backend's lookup takes all three (proposed). Without it, ids
// still resolve through Offers' own lookup (real, /admin/offers/players/lookup) and emails and phones come back as
// not found with the reason, so the Offers page keeps what it had.
export const LOOKUP_MAX = 2000;
export async function readTokenLookup(auth: OffersAuth, text: string): Promise<TokenLookup & { note?: string }> {
  const t = parseTokens(text);
  if (fixtureOn()) return fixture.lookup(t);
  if (t.all.length === 0) return { players: [], notFound: t.bad };
  try {
    const r = await pushesPost<TokenLookup>(auth, `${PUSHES}/players/lookup`, { ids: t.ids, emails: t.emails, phones: t.phones });
    return { players: r.players, notFound: [...r.notFound, ...t.bad] };
  } catch (e) {
    if (!missingRoute(e)) throw e;
  }
  const players: FoundPlayer[] = [];
  const notFound: string[] = [...t.bad];
  if (t.ids.length) {
    const r = await readPlayerLookup(auth, t.ids.slice(0, LOOKUP_MAX));
    for (const p of r.players) players.push({ id: p.id, name: p.name, city: p.city, token: String(p.id) });
    for (const id of r.notFound) notFound.push(String(id));
  }
  const rest = [...t.emails, ...t.phones];
  return { players, notFound: [...notFound, ...rest], note: rest.length ? "Emails and phone numbers can be looked up once the Push Notifications backend is on this server; IDs work now." : undefined };
}

// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────
// The same shape as offersWrite: one request, never retried, the verdict from the push the write returns.
export type WriteResult = { verdict: Verdict; after: PushCampaign | null; error?: string; detail?: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedIds = (v: unknown) => (Array.isArray(v) ? [...v].sort((x, y) => Number(x) - Number(y)) : v);
export function pushMismatches(expected: Record<string, unknown>, after: Record<string, unknown> | null): string[] {
  if (!after) return Object.keys(expected);
  return Object.keys(expected).filter((k) => (PUSH_ID_SETS.has(k) ? !same(sortedIds(expected[k]), sortedIds(after[k])) : !same(expected[k], after[k])));
}
export async function pushesWrite(opts: {
  auth: OffersAuth; source: string; method: "POST" | "PATCH" | "DELETE"; path: string; body?: Record<string, unknown>;
  id: number | null; expect: Record<string, unknown>; expectGone?: boolean; before?: PushCampaign;
  check?: (after: Record<string, unknown>) => string[];
}): Promise<WriteResult> {
  if (fixtureOn()) {
    const r = fixture.write(opts.method, opts.path, opts.body, opts.auth.email);
    if ("error" in r) return { verdict: "FAILED", after: null, error: r.error };
    const missing = opts.expectGone ? (r.after ? ["gone"] : []) : (opts.check ?? ((x) => pushMismatches(opts.expect, x)))((r.after ?? {}) as unknown as Record<string, unknown>);
    return { verdict: missing.length === 0 ? "LANDED" : "NOT APPLIED", after: r.after, detail: missing.length ? "The fixture answered, but the change doesn't show when read back." : undefined };
  }
  let createdId: number | null = opts.id;
  let wrote = false;
  let after: PushCampaign | null | undefined;
  const { outcome, error } = await recordWrite(
    {
      env: _offersCfg().env, source: opts.source, actorName: opts.auth.email, actorEmail: opts.auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: opts.method, path: opts.path,
      body: offersLogBody(opts.body ?? {}), keys: Object.keys(opts.expect), label: (k) => k,
      applied: (_b, seen) => (after === undefined ? "unknown" : opts.expectGone ? seen.missing === true : (opts.check ?? ((x) => pushMismatches(opts.expect, x)))(seen).length === 0),
    },
    {
      readResource: async () => {
        if (!wrote) return (opts.before ?? {}) as unknown as Record<string, unknown>;
        if (opts.expectGone) after = createdId === null ? null : await readPush(createdId);
        return (after as unknown as Record<string, unknown>) ?? { missing: true };
      },
      write: async () => {
        const r = await offersApiWrite<Record<string, unknown>>(opts.auth, opts.method, opts.path, opts.body);
        if (r && typeof r === "object" && typeof r.id === "number") {
          if (createdId === null) createdId = r.id;
          after = r as unknown as PushCampaign;
        }
        wrote = true;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    _offersLogStore(),
  );
  const missing = opts.check && after ? opts.check(after as unknown as Record<string, unknown>) : pushMismatches(opts.expect, (after ?? null) as unknown as Record<string, unknown> | null);
  const verdict: Verdict = error ? (outcome === "unknown" ? "UNKNOWN" : "FAILED") : after === undefined ? "UNKNOWN" : opts.expectGone ? (after === null ? "LANDED" : "NOT APPLIED") : missing.length === 0 ? "LANDED" : "NOT APPLIED";
  if (verdict === "NOT APPLIED") console.error(`[pushes] ${opts.source}: NOT APPLIED, the read-back does not show ${opts.expectGone ? "it gone" : missing.join(", ")}`);
  return {
    verdict, after: after ?? null,
    error: error ? pushesErrorText(error) : undefined,
    detail: verdict === "NOT APPLIED" ? "The backend answered, but the change doesn't show when read back. Refresh and check before trying again." : undefined,
  };
}
export const verdictResponse = (w: WriteResult) => Response.json({ verdict: w.verdict, error: w.error, detail: w.detail, after: w.after }, { status: w.verdict === "FAILED" ? 502 : 200 });

// SEND: the backend queues it (now, or at the time). LANDED when the push comes back SCHEDULED or SENT.
export const sendPush = (auth: OffersAuth, id: number, before?: PushCampaign) => pushesWrite({
  auth, source: "pushes:send", method: "POST", path: `${PUSHES}/${id}/send`, id, expect: { status: "SENT" }, before,
  check: (after) => (after.status === "SENT" || after.status === "SCHEDULED" ? [] : ["status"]),
});

// A TEST to the signed-in person's own phones, with the text as typed (unsaved is fine). Nothing is read back.
export async function sendTestPush(auth: OffersAuth, id: number, text: { title: string; body: string }): Promise<Response> {
  try {
    const a = fixtureOn() ? fixture.test(id) : await offersApiWrite<{ sent?: number; failed?: number }>(auth, "POST", `${PUSHES}/${id}/test`, text);
    const o = testSendOutcome(a);
    return Response.json({ verdict: o.verdict, text: o.text, sent: a.sent, failed: a.failed });
  } catch (e) {
    console.error(`[pushes] test push ${id}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    return Response.json({ verdict: "FAILED", error: missingRoute(e) ? NO_PUSHES_BACKEND : testPushErrorText(e, auth.email) }, { status: 502 });
  }
}

export type Offers = { campaigns: Campaign[] };
