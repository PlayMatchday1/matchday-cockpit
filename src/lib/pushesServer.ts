import "server-only";
// MATCH OPS › PUSH NOTIFICATIONS and the shared audience, the server half for /api/pushes/* and /api/audiences/*. The
// same gate, config, pacer and write pipeline as Offers (src/lib/offersServer.ts): Match Ops access, OFFERS_ENV says
// which backend, one paced read at a time (shared with Offers), every write once through recordWrite with the verdict
// read back from the backend's own answer.
//
// THE CONTRACT is backend docs/push-notifications.md: /admin/push-notifications (the list, and message pushes under
// /messages) and /admin/audiences (count, sample, players/lookup). A backend without them answers 404 with no
// errorCode ("Cannot GET"), and the page then says so and writes nothing.
//
// THE FIXTURE (src/lib/pushesFixture.ts) stands in for that backend on a dev server only (PUSHES_FIXTURE=1, refused
// under NODE_ENV=production and on Vercel). It records no change_log row: nothing it does reaches a player.

import { randomUUID } from "node:crypto";
import { recordWrite } from "@/lib/changeLog";
import { apiGet, apiWrite, WriteFailedError } from "@/lib/matchdayStageApi";
import { offersLogBody } from "@/lib/offersModel";
import { _offersCfg, _offersLogStore, _offersPaced, errorText, offersApiWrite, readPlayerLookup, sendLoggedTest, type OffersAuth, type TestTarget, type Verdict } from "@/lib/offersServer";
import { READS_STOPPED } from "@/lib/offersPacing";
import { entriesOf, MAX_ENTRIES, type ContractAudience, type ContractCount, type TokenLookup } from "@/lib/audienceModel";
import { pushMismatches, type ListPage, type PushMessage, type PushReachable, type PushResultsData } from "@/lib/pushesModel";
import { fixture } from "@/lib/pushesFixture";

export const PUSHES = "/admin/push-notifications";
export const MESSAGES = `${PUSHES}/messages`;
export const AUDIENCES = "/admin/audiences";
export type Backend = "ready" | "missing";
export const NO_PUSHES_BACKEND = "The Push Notifications backend isn't on this server yet.";

export const fixtureOn = (env: Record<string, string | undefined> = process.env) => env.NODE_ENV !== "production" && !env.VERCEL && env.PUSHES_FIXTURE === "1";

// A route the backend doesn't have: a Nest 404 with no errorCode ("Cannot GET ..."), or a web page (staging, 200).
export function missingRoute(e: unknown): boolean {
  if (e instanceof SyntaxError) return true;
  if (e instanceof WriteFailedError && e.status === 404) { try { return !JSON.parse(e.bodySnippet).errorCode; } catch { return true; } }
  return false;
}
function backendCode(e: unknown): { code: string | null; message: string | null } {
  try { const j = JSON.parse(e instanceof WriteFailedError ? e.bodySnippet : ""); return { code: j.errorCode ?? null, message: Array.isArray(j.message) ? j.message.join("; ") : j.message ?? null }; }
  catch { return { code: null, message: null }; }
}
export function pushesErrorText(e: unknown): string {
  if (missingRoute(e)) return NO_PUSHES_BACKEND;
  if (e instanceof Error && e.name === READS_STOPPED) return "The backend just had a problem, so reads have stopped for a moment. Try again in 30 seconds.";
  const { code, message } = backendCode(e);
  const after = message?.split(": ").slice(1).join(": ") || message || "";
  if (code === "INVALID_AUDIENCE") return `The backend refused the audience: ${after || "a filter is not valid"}. Nothing was saved.`;
  if (code === "PUSH_CAMPAIGN_LOCKED") return `Those parts can't change any more (${after || "locked fields"}). Nothing was saved.`;
  if (code === "INVALID_PUSH_CAMPAIGN") return `The backend refused it: ${after || "the push is not valid"}. Nothing was sent.`;
  if (code === "PUSH_CAMPAIGN_STATUS_CHANGE_NOT_ALLOWED") return "It can't move to that status from where it is now. Refresh to see its status.";
  return errorText(e);
}

// ── READS ────────────────────────────────────────────────────────────────────────────────────────
const paced = _offersPaced;
function get<T>(path: string): Promise<T> {
  const { env, baseUrl } = _offersCfg();
  return paced(() => apiGet<T>(env, path, undefined, baseUrl));
}
// A read the backend takes as a POST (count, sample, lookup); not a write, so not through recordWrite.
function postRead<T>(auth: OffersAuth, path: string, body: unknown): Promise<T> {
  const { env, baseUrl } = _offersCfg();
  return paced(() => apiWrite<T>(env, "POST", path, body, auth.actor, "offers", undefined, undefined, baseUrl));
}

export async function readList(): Promise<{ page: ListPage | null; backend: Backend; error?: string }> {
  if (fixtureOn()) return { page: fixture.list(), backend: "ready" };
  try { return { page: await get<ListPage>(PUSHES), backend: "ready" }; }
  catch (e) { return missingRoute(e) ? { page: null, backend: "missing" } : { page: null, backend: "missing", error: pushesErrorText(e) }; }
}
export async function readPush(id: number): Promise<PushMessage | null> {
  if (fixtureOn()) return fixture.get(id);
  try { return await get<PushMessage>(`${MESSAGES}/${id}`); }
  catch (e) { if (e instanceof WriteFailedError && e.status === 404 && !missingRoute(e)) return null; throw e; }
}
export const readPushResults = (id: number): Promise<PushResultsData> => (fixtureOn() ? Promise.resolve(fixture.results(id)) : get<PushResultsData>(`${MESSAGES}/${id}/results`));
export const readReachable = (id: number): Promise<PushReachable> => (fixtureOn() ? Promise.resolve(fixture.reachable(id)) : get<PushReachable>(`${MESSAGES}/${id}/reachable`));

// THE SHARED AUDIENCE (POST /admin/audiences/*), for message pushes and offers alike.
export const readCount = (auth: OffersAuth, audience: ContractAudience, holdoutPercent?: number): Promise<ContractCount> =>
  fixtureOn() ? Promise.resolve(fixture.count(audience, holdoutPercent)) : postRead<ContractCount>(auth, `${AUDIENCES}/count`, { audience, ...(holdoutPercent !== undefined ? { holdoutPercent } : {}) });
export type SamplePlayer = { id: number; name: string | null; city: string | null; lastPlayedAt: string | null };
export const SAMPLE_LIMIT = 50;
export const readSample = (auth: OffersAuth, audience: ContractAudience): Promise<{ players: SamplePlayer[] }> =>
  fixtureOn() ? Promise.resolve(fixture.sample(audience)) : postRead<{ players: SamplePlayer[] }>(auth, `${AUDIENCES}/sample`, { audience, limit: SAMPLE_LIMIT });
// EXACT PLAYERS: ids, emails and phones, as pasted. A backend without the shared lookup still resolves ids through
// Offers' own (/admin/offers/players/lookup); emails and phones then come back not found, with the reason.
export async function readLookup(auth: OffersAuth, text: string): Promise<TokenLookup & { note?: string }> {
  const entries = entriesOf(text).slice(0, MAX_ENTRIES);
  if (entries.length === 0) return { players: [], notFound: [] };
  if (fixtureOn()) return fixture.lookup(entries);
  try { return await postRead<TokenLookup>(auth, `${AUDIENCES}/players/lookup`, { entries }); }
  catch (e) { if (!missingRoute(e)) throw e; }
  const ids = entries.map((x) => x.replace(/^#/, "")).filter((x) => /^\d+$/.test(x)).map(Number);
  const rest = entries.filter((x) => !/^#?\d+$/.test(x));
  const found = ids.length ? await readPlayerLookup(auth, ids.slice(0, 2000)) : { players: [], notFound: [] as number[] };
  return {
    players: found.players.map((p) => ({ id: p.id, name: p.name, city: p.city, entry: String(p.id) })),
    notFound: [...found.notFound.map(String), ...rest],
    note: rest.length ? "Emails and phone numbers are looked up once the new audience backend is on this server; IDs work now." : undefined,
  };
}

// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────
// The same shape as offersWrite: one request, never retried, the verdict from the push the write answers with.
export type WriteResult = { verdict: Verdict; after: PushMessage | null; error?: string; detail?: string };
export async function pushesWrite(opts: {
  auth: OffersAuth; source: string; method: "POST" | "PATCH"; path: string; body?: Record<string, unknown>; id: number | null;
  before?: PushMessage;
  // What the push it answers with must show; by default every key sent, as stored.
  check?: (after: PushMessage) => string[];
}): Promise<WriteResult> {
  const sent = opts.body ?? {};
  const check = opts.check ?? ((after: PushMessage) => pushMismatches(sent, after));
  if (fixtureOn()) {
    const r = fixture.write(opts.method, opts.path, opts.body, opts.auth.email);
    if ("error" in r) return { verdict: "FAILED", after: null, error: r.error };
    const missing = check(r.after);
    return { verdict: missing.length === 0 ? "LANDED" : "NOT APPLIED", after: r.after, detail: missing.length ? "The fixture answered, but the change doesn't show when read back." : undefined };
  }
  let wrote = false;
  let after: PushMessage | undefined;
  const { outcome, error } = await recordWrite(
    {
      env: _offersCfg().env, source: opts.source, actorName: opts.auth.email, actorEmail: opts.auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: opts.method, path: opts.path,
      // The exact list is logged as a count, never as ids (offersLogBody), and a message body is the push's own copy.
      body: logBody(sent), keys: Object.keys(sent), label: (k) => k,
      applied: () => (after === undefined ? "unknown" : check(after).length === 0),
    },
    {
      readResource: async () => (!wrote ? ((opts.before ?? {}) as unknown as Record<string, unknown>) : ((after as unknown as Record<string, unknown>) ?? { missing: true })),
      write: async () => {
        const r = await offersApiWrite<Record<string, unknown>>(opts.auth, opts.method, opts.path, opts.body);
        if (r && typeof r === "object" && typeof r.id === "number") after = r as unknown as PushMessage;
        wrote = true;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    _offersLogStore(),
  );
  const missing = after ? check(after) : [];
  const verdict: Verdict = error ? (outcome === "unknown" ? "UNKNOWN" : "FAILED") : after === undefined ? "UNKNOWN" : missing.length === 0 ? "LANDED" : "NOT APPLIED";
  if (verdict === "NOT APPLIED") console.error(`[pushes] ${opts.source}: NOT APPLIED, the read-back does not show ${missing.join(", ")}`);
  return {
    verdict, after: after ?? null, error: error ? pushesErrorText(error) : undefined,
    detail: verdict === "NOT APPLIED" ? "The backend answered, but the change doesn't show when read back. Refresh and check before trying again." : undefined,
  };
}
// An audience's exact list as a count in the log, as Offers logs playerIds.
function logBody(b: Record<string, unknown>): Record<string, unknown> {
  const a = b.audience as ContractAudience | undefined;
  const out = offersLogBody(b);
  if (a?.mode === "PLAYERS") out.audience = { mode: "PLAYERS", playerCount: a.playerIds.length };
  return out;
}
export const verdictResponse = (w: WriteResult) => Response.json({ verdict: w.verdict, error: w.error, detail: w.detail, after: w.after }, { status: w.verdict === "FAILED" ? 502 : 200 });

// SEND / PAUSE / END: LANDED when the push comes back in the status the move means.
export type Move = "send" | "pause" | "end";
const MOVED: Record<Move, string> = { send: "LAUNCHED", pause: "PAUSED", end: "ENDED" };
export const movePush = (auth: OffersAuth, id: number, move: Move, before?: PushMessage) => pushesWrite({
  auth, source: `pushes:${move}`, method: "POST", path: `${MESSAGES}/${id}/${move}`, id, before,
  check: (after) => (after.status === MOVED[move] ? [] : ["status"]),
});

// A TEST to one player (the Send to box; the signed-in person when it is empty), with the text as typed. Logged and
// never retried, through the same function as an offer's test (sendLoggedTest).
export async function sendTestPush(auth: OffersAuth, id: number, text: { title: string; body: string }, to: { target: TestTarget; who: string | null }): Promise<Response> {
  if (fixtureOn()) { const a = fixture.test(id, to.target); return "error" in a ? Response.json({ verdict: "FAILED", error: a.error }, { status: 502 }) : Response.json({ verdict: "SENT", ...a }); }
  return sendLoggedTest(auth, `${MESSAGES}/${id}/test`, "pushes:test", text, to);
}
