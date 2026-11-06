import "server-only";
// MATCH OPS › OFFERS, the server half shared by every /api/offers/* route.
//
// WHERE IT TALKS TO comes from the environment (src/lib/offersConfig.ts): OFFERS_ENV, the backend's
// base URL and the allowed upload host. Anything unset or wrong answers 503, for everyone.
//
// TWO GATES, in order: Match Ops access (authenticateMatchOpsRead, the same check the Match Ops section
// uses, read fresh from app_users on every request, and never a city-confined account), then the config (503). So someone with no session
// only ever gets 401, and someone without access only ever gets the 404 a missing route gives. The backend's ADMIN-only rule is a separate check on the service
// account; it says nothing about which Clubhouse user is asking. Who did a write is in change_log and in
// X-Acting-Staff-Email, both from the session.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { StageConfigError, apiGet, apiWrite, WriteFailedError, type WriteActor } from "@/lib/matchdayStageApi";
import { OFFERS_NOT_FOUND } from "@/lib/offersAccess";
import { readOffersConfig, type OffersConfig, type OffersConfigResult } from "@/lib/offersConfig";
import { chicagoWallNow, offerMatchOpt, offersLogBody, photoUrlOk, pickerRange, showAgainWhy, wallFromMatch, type ApiOfferMatch, type Campaign, type City, type FieldCover, type FieldOpt, type MatchOpt, type ShowAgainPreview, type ShowAgainReason } from "@/lib/offersModel";
import { OFFERS_READ_PACE_MS, READS_STOPPED, makePacer } from "@/lib/offersPacing";
import { pushesVisible, type CampaignPush, type PushMode, type PushResults, type Reach } from "@/lib/offersPush";
import { STAFF_NOT_ALLOWED_PLAIN, WHO_ARE_YOU, staffEmailOf, staffErrorKind } from "@/lib/staffIdentity";

export const CAMPAIGNS = "/admin/offers/campaigns";
export const MATCHES = "/admin/offers/matches";
export const PHOTO_UPLOADS = "/admin/offers/photo-uploads";

export type OffersAuth = { email: string; actor: WriteActor; supabase: SupabaseClient };

type GateDeps = { config: () => OffersConfigResult; authenticate: (req: Request) => ReturnType<typeof authenticateMatchOpsRead>; logStore: typeof supabaseLogStore; sleep: (ms: number) => Promise<void>; now: () => number };
const realDeps: GateDeps = { config: readOffersConfig, authenticate: authenticateMatchOpsRead, logStore: supabaseLogStore, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
let gateDeps: GateDeps = realDeps;
// FOR scripts/offers-model-test.ts ONLY: run the real gate and the real writes as each kind of caller, offline.
export function _setOffersGateDepsForTest(d: Partial<GateDeps> | null) { gateDeps = d ? { ...realDeps, ...d } : realDeps; }

// The config for this request. offersGate has already answered 503 if there is none; this throw is
// the same refusal for anything that reaches a read or write some other way.
function cfg(): OffersConfig {
  const r = gateDeps.config();
  if (!r.ok) throw new StageConfigError(`Offers config: ${r.problem}`);
  return r.config;
}

export async function offersGate(req: Request): Promise<OffersAuth | Response> {
  const auth = await gateDeps.authenticate(req);
  if (!auth.ok) return auth.status === 403 ? Response.json(OFFERS_NOT_FOUND, { status: 404 }) : Response.json({ error: auth.error }, { status: auth.status });
  // A CITY-CONFINED ACCOUNT NEVER USES OFFERS. authenticateMatchOpsRead already refuses it here, because /api/offers is
  // not on the confined route allowlist (cityConfinement.ts); this holds even if someone adds it there.
  if (auth.confined) return Response.json(OFFERS_NOT_FOUND, { status: 404 });
  const config = gateDeps.config();
  if (!config.ok) {
    console.error(`[offers] closed: ${config.problem}`);
    return Response.json({ error: "Offers isn't set up on this server." }, { status: 503 });
  }
  // Every write carries the session's person; without a usable email it is refused here, before the backend.
  if (req.method !== "GET" && !staffEmailOf(auth.email)) return Response.json({ error: WHO_ARE_YOU }, { status: 401 });
  return { email: auth.email, supabase: auth.supabase, actor: { canEditMatches: false, canUseOffers: true, email: auth.email, userId: auth.appUserId } };
}

// ── PLAIN WORDS for the backend's refusals ──────────────────────────────────────────────────────
export const GENERIC = "Something went wrong and nothing was changed. Try again, and tell Ryan if it keeps happening.";
function backendMessage(e: unknown): { code: string | null; message: string | null } {
  const snippet = e instanceof WriteFailedError ? e.bodySnippet : "";
  try {
    const j = JSON.parse(snippet) as { errorCode?: string; message?: string | string[] };
    return { code: j.errorCode ?? null, message: Array.isArray(j.message) ? j.message.join("; ") : j.message ?? null };
  } catch { return { code: null, message: null }; }
}
// OFFER_SHOW_AGAIN_NOT_ALLOWED carries the reason beside the message (errorData.reason, errorData.nextAllowedAt).
function showAgainErrorData(e: unknown): { reason: ShowAgainReason | null; nextAllowedAt: string | null } {
  const snippet = e instanceof WriteFailedError ? e.bodySnippet : "";
  try {
    const j = JSON.parse(snippet) as { errorData?: { reason?: ShowAgainReason; nextAllowedAt?: string | null } };
    return { reason: j.errorData?.reason ?? null, nextAllowedAt: j.errorData?.nextAllowedAt ?? null };
  } catch { return { reason: null, nextAllowedAt: null }; }
}
const NO_PUSHES = "This backend doesn't have offer pushes yet, so nothing was sent or saved.";
const NO_PUSH_ROUTE = "OffersNoPushRoute";
export const NO_OFFERS = "Offers isn't deployed on this backend yet.";
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const staff = staffErrorKind(raw);
  if (staff === "WHO") return WHO_ARE_YOU;
  if (staff === "NOT_ALLOWED") {
    console.error(`[offers] backend refused X-Acting-Staff-Email (STAFF_EMAIL_NOT_ALLOWED): ${raw.slice(0, 300)}`);
    return STAFF_NOT_ALLOWED_PLAIN;
  }
  // A route the backend doesn't have can answer 200 with a web page (staging did, 2026-10-30).
  // A backend without offer pushes yet answers their routes with a 404 that carries no errorCode: Nest's own
  // ("Cannot PUT ...") or, on the local build, {"message":"Not Found"}. The push 404s it means carry one.
  if (e instanceof WriteFailedError && e.status === 404 && /\/push(\/|-settings|\b)/.test(raw) && backendMessage(e).code === null) return NO_PUSHES;
  if (e instanceof Error && e.name === NO_PUSH_ROUTE) return NO_PUSHES;
  // A backend without Offers at all answers a page read the same way. Every 404 the Offers module raises carries an
  // errorCode (backend core/offers/constants.ts: NOT_FOUND_OFFER_CAMPAIGN, NOT_FOUND_OFFER, NOT_FOUND_PREVIEW_PLAYER).
  if (e instanceof WriteFailedError && e.status === 404 && /^GET \S*\/admin\/offers\//.test(raw) && backendMessage(e).code === null) return NO_OFFERS;
  if (e instanceof SyntaxError) { console.error(`[offers] the backend's answer was not JSON: ${raw.slice(0, 200)}`); return "The backend answered with something that isn't JSON. Offers may not be deployed there."; }
  if (e instanceof Error && e.name === READS_STOPPED) return "The backend just had a problem, so reads have stopped for a moment. Try again in 30 seconds.";
  const { code, message } = backendMessage(e);
  if (code === "OFFER_CAMPAIGN_FIELD_LOCKED") return `Those parts can't change once it has launched (${message?.split(": ")[1] ?? "locked fields"}). Nothing was saved.`;
  if (code === "INVALID_OFFER_CAMPAIGN") return `The backend refused it: ${message?.split(": ").slice(1).join(": ") || "the offer is not valid"}. Nothing was saved.`;
  if (code === "OFFER_PUSH_LOCKED") return "The push is already queued, so it can't change now. Nothing was saved.";
  if (code === "INVALID_OFFER_PUSH") return `The backend refused the push: ${message?.split(": ").slice(1).join(": ") || message || "the push is not valid"}. Nothing was sent.`;
  if (code === "OFFER_SHOW_AGAIN_NOT_ALLOWED") {
    const data = showAgainErrorData(e);
    return `Show again didn't run: ${showAgainWhy(data.reason, data.nextAllowedAt) ?? message ?? "the backend refused it"} Nothing changed.`;
  }
  if (code === "OFFER_CAMPAIGN_STATUS_CHANGE_NOT_ALLOWED") return "It can't move to that status from where it is now. Refresh to see its current status.";
  if (code === "NOT_FOUND_OFFER_CAMPAIGN") return "That offer no longer exists. Refresh the list.";
  if (e instanceof WriteFailedError && e.status === 400 && message) return `The backend refused it: ${message}. Nothing was saved.`;
  console.error(`[offers] unmapped error, shown as generic: ${raw.slice(0, 500)}`);
  return GENERIC;
}

// ── READS ───────────────────────────────────────────────────────────────────────────────────────
// EVERY OTHER READ GOES THROUGH THE PACER (src/lib/offersPacing.ts) at the repo's rule for the production API:
// one at a time, one every 2 seconds. Never nest paced() inside paced(): the inner one waits behind the outer.
const paced = makePacer({ paceMs: OFFERS_READ_PACE_MS, sleep: (ms) => gateDeps.sleep(ms), now: () => gateDeps.now(), stopsOn: (e) => !(e instanceof WriteFailedError && e.status >= 400 && e.status < 500) });
export function offersGet<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
  const { env, baseUrl } = cfg();
  return paced(() => apiGet<T>(env, path, query, baseUrl));
}

// THE PAGE'S LOAD (GET admin/offers/page): campaigns, cities and fields in one read, which is why it
// alone skips the pacer. Cut down to what the page uses, by the same rule as every other read here.
type ApiPage = {
  campaigns: Campaign[];
  cities: { id: number; name: string; timeZone?: string | null }[];
  fields: { id: number; title: string; cityId: number | null; cover?: string | null; covers?: FieldCover[] }[];
};
export async function readPage(): Promise<{ campaigns: Campaign[]; cities: City[]; fields: FieldOpt[] }> {
  const { env, baseUrl } = cfg();
  const r = await apiGet<ApiPage>(env, "/admin/offers/page", undefined, baseUrl);
  return {
    campaigns: r.campaigns,
    cities: r.cities.map((c) => ({ id: c.id, name: c.name, timeZone: c.timeZone ?? null })),
    fields: r.fields.map((f) => ({ id: f.id, title: f.title, cityId: f.cityId ?? null, cover: f.cover ?? null, ...(Array.isArray(f.covers) ? { covers: f.covers } : {}) })),
  };
}
export async function readCampaign(id: number): Promise<Campaign | null> {
  try { return await offersGet<Campaign>(`${CAMPAIGNS}/${id}`); }
  catch (e) { if (e instanceof WriteFailedError && e.status === 404) return null; throw e; }
}

// A match from admin/matches, cut down to what the page shows. The payload carries teams[].password
// and players' details; none of it crosses to the browser. startDate is WALL CLOCK; upcoming is
// decided from startDateUtc, which is TRUE UTC.
type ApiMatch = {
  id: number; name: string; startDate: string; startDateUtc: string; isCancelled: boolean; fieldId: number | null;
  registrationPrice: number; maxPlayerCount: number; minPlayerCount: number;
  field?: { title: string; cityId: number; cover?: string | null } | null; coverUrl?: string | null; _count?: { players: number };
};
export function matchOpt(m: ApiMatch, now = Date.now()): MatchOpt {
  return {
    id: m.id, name: m.name, startLocal: wallFromMatch(m.startDate), fieldId: m.fieldId, fieldTitle: m.field?.title ?? null, fieldCover: m.coverUrl ?? m.field?.cover ?? null,
    cityId: m.field?.cityId ?? null, price: m.registrationPrice, players: m._count?.players ?? 0,
    maxPlayers: m.maxPlayerCount, minPlayers: m.minPlayerCount, upcoming: !m.isCancelled && Date.parse(m.startDateUtc) > now,
  };
}
// THE MATCH LIST (GET admin/offers/matches): upcoming and not cancelled, soonest first, in the picker's
// longest range. The page's load takes ONE page of it, paced like the rest (right after the page read when
// nothing else has read lately) and says whether that was all of them. Only when it
// wasn't does the panel ask for its own cities' list, walked here, stopping at the
// first error and after MAX_MATCH_PAGES. Search and Needs players filter in the browser: the design
// searches by time as well, which the endpoint doesn't, and it saves a read for every key.
export const MATCH_PAGE = 100;
export const MAX_MATCH_PAGES = 5;
type Page<T> = { page: number; limit: number; totalItems: number; data: T[] };
const matchPage = (page: number, cityIds: number[]) => offersGet<Page<ApiOfferMatch>>(MATCHES, {
  ...pickerRange(chicagoWallNow()), ...(cityIds.length ? { cityIds: cityIds.join(",") } : {}), page, limit: MATCH_PAGE,
});
export type MatchList = { matches: MatchOpt[]; complete: boolean };
export async function readFirstMatchPage(): Promise<MatchList> {
  const r = await matchPage(1, []);
  return { matches: (r.data ?? []).map(offerMatchOpt), complete: (r.data ?? []).length >= r.totalItems };
}
export async function readMatchesForCities(cityIds: number[]): Promise<MatchList> {
  const out: ApiOfferMatch[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_MATCH_PAGES; page++) {
    const r = await matchPage(page, cityIds);
    out.push(...(r.data ?? []));
    total = r.totalItems;
    if (!r.data?.length || out.length >= total) break;
  }
  return { matches: out.map(offerMatchOpt), complete: out.length >= total };
}
// THE LIVE COUNT (POST admin/offers/campaigns/audience-count). A READ that the backend takes as a
// POST: it goes through the guarded write client (host check) because that is the client that can
// POST, but it changes nothing, so it is not put through recordWrite and carries no staff header. It
// lives here rather than in its route so write-routes-logged-test keeps meaning "every apiWrite in a
// route is a logged write". Paced: it fires as someone changes the audience.
export type AudienceCount = { count: number; heldBack: number; players: number; mostItCanCost: number | null; on188?: number };
export const readAudienceCount = (auth: OffersAuth, body: Record<string, unknown>) => paced(() => {
  const { env, baseUrl } = cfg();
  return apiWrite<AudienceCount>(env, "POST", `${CAMPAIGNS}/audience-count`, body, auth.actor, "offers", undefined, undefined, baseUrl);
});

// One match, read when an offer that names it is opened (GET /api/offers/matches/{id}), never on page load.
export const readMatch = async (id: number): Promise<MatchOpt> => matchOpt(await offersGet<ApiMatch>(`/admin/matches/${id}`));

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────
// One request, never retried, through recordWrite (which stores nothing in local mode). The answer
// comes from THE CAMPAIGN THE WRITE RETURNS, compared with what the write meant to leave behind:
// LANDED / FAILED / NOT APPLIED / UNKNOWN. A 2xx alone is never reported as landed. A delete returns
// nothing, so it alone is read back. No read before a write either: the backend checks the match, the
// players and the end on launch, and answers with what's wrong (Ryan, 2026-10-30). The exception is an
// edit, whose route reads first because change_log records each field's value before.
export type Verdict = "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN";

export function offersApiWrite<T = unknown>(auth: OffersAuth, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const staff = staffEmailOf(auth.email);
  if (!staff) return Promise.reject(new Error(WHO_ARE_YOU));
  const { env, baseUrl } = cfg();
  return apiWrite<T>(env, method, path, body, auth.actor, "offers", undefined, staff, baseUrl);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Id sets: the backend may store them in its own order (playerIds come back sorted), and order means nothing.
const ID_SETS = new Set(["cityIds", "fieldIds", "playerIds", "appliesFieldIds"]);
const sortedIds = (v: unknown) => (Array.isArray(v) ? [...v].sort((x, y) => Number(x) - Number(y)) : v);
export function mismatches(expected: Record<string, unknown>, after: Record<string, unknown> | null): string[] {
  if (!after) return Object.keys(expected);
  return Object.keys(expected).filter((k) => (ID_SETS.has(k) ? !same(sortedIds(expected[k]), sortedIds(after[k])) : !same(expected[k], after[k])));
}

export type WriteResult = { verdict: Verdict; after: Campaign | null; error?: string; detail?: string };

export async function offersWrite(opts: {
  auth: OffersAuth; source: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string;
  // undefined = a bodyless write (launch, pause, end): no body and no content-type, which the
  // backend requires (Fastify rejects an empty JSON body).
  body?: Record<string, unknown>;
  // The campaign the write is about, or null for a create (read by the id the response carries).
  id: number | null;
  expect: Record<string, unknown>;
  // A delete: LANDED only when the read-back finds no campaign at all.
  expectGone?: boolean;
  // The campaign as the route just read it, so it isn't read a second time before the write.
  before?: Campaign;
  // What the read-back must show, when it isn't simply expect's keys (the push PUT checks campaign.push).
  check?: (after: Record<string, unknown>) => string[];
}): Promise<WriteResult> {
  let createdId: number | null = opts.id;
  const read = async () => (createdId === null ? null : await readCampaign(createdId));
  // recordWrite asks for the resource before and after the write. Before is what the route read, if it
  // did. After is the write's own answer: undefined means it didn't answer with a campaign.
  let wrote = false;
  let after: Campaign | null | undefined;
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: opts.source, actorName: opts.auth.email, actorEmail: opts.auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: opts.method, path: opts.path,
      body: offersLogBody(opts.body ?? {}), keys: Object.keys(opts.expect), label: (k) => k,
      // The same three answers the route gives below, so the log and the page can't disagree.
      applied: (_b, seen) => (after === undefined ? "unknown" : opts.expectGone ? seen.missing === true : (opts.check ?? ((x) => mismatches(opts.expect, x)))(seen).length === 0),
    },
    {
      readResource: async () => {
        if (!wrote) return (opts.before ?? {}) as unknown as Record<string, unknown>;
        if (opts.expectGone) after = await read();
        return (after as unknown as Record<string, unknown>) ?? { missing: true };
      },
      write: async () => {
        const r = await offersApiWrite<Record<string, unknown>>(opts.auth, opts.method, opts.path, opts.body);
        if (r && typeof r === "object" && typeof r.id === "number") {
          if (createdId === null) createdId = r.id;
          after = r as unknown as Campaign;
        }
        wrote = true;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  const missing = opts.check && after ? opts.check(after as unknown as Record<string, unknown>) : mismatches(opts.expect, (after ?? null) as unknown as Record<string, unknown> | null);
  const verdict: Verdict = error
    ? (outcome === "unknown" ? "UNKNOWN" : "FAILED")
    : after === undefined ? "UNKNOWN"
    : opts.expectGone ? (after === null ? "LANDED" : "NOT APPLIED")
    : missing.length === 0 ? "LANDED" : "NOT APPLIED";
  if (verdict === "NOT APPLIED") console.error(`[offers] ${opts.source}: NOT APPLIED, the read-back does not show ${opts.expectGone ? "it gone" : missing.join(", ")}`);
  return {
    verdict, after: after ?? null,
    error: error ? errorText(error) : undefined,
    detail: verdict === "NOT APPLIED" ? "The backend answered, but the change doesn't show when read back. Refresh and check before trying again." : undefined,
  };
}

export function verdictResponse(w: WriteResult): Response {
  return Response.json({ verdict: w.verdict, error: w.error, detail: w.detail, after: w.after }, { status: w.verdict === "FAILED" ? 502 : 200 });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    return b as Record<string, unknown>;
  } catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
}

// ── SEND TEST (POST admin/offers/campaigns/{id}/send-preview) ─────────────────────────────────
// The popup on up to 20 players' phones, on their next app open; with no ids, the player account
// with the staff person's own email (Use my email). Nothing in the admin API reads a preview back,
// so a 2xx is reported as SENT (the backend took it, for the ids it names in `sent`), never as
// arrived. It is a write (it stores previews), so it goes through recordWrite like the rest.
export async function sendPreview(auth: OffersAuth, id: number, userIds: number[]): Promise<Response> {
  const path = `${CAMPAIGNS}/${id}/send-preview`;
  let answer: { sent?: number[]; notFound?: number[] } | null = null;
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: "offers:send-preview", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "POST", path, body: offersLogBody({ userIds }), keys: [], label: (k) => k,
      applied: () => (answer !== null && Array.isArray(answer.sent) ? true : "unknown"),
    },
    {
      readResource: async () => ({}),
      write: async () => {
        const r = await offersApiWrite<{ sent?: number[]; notFound?: number[] }>(auth, "POST", path, { userIds });
        answer = r ?? null;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  if (error) {
    const { code } = backendMessage(error);
    const text = code === "NOT_FOUND_PREVIEW_PLAYER"
      ? `No player account in the app uses ${auth.email}. Sign up in the app with that email, then send it again.`
      : errorText(error);
    return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: text }, { status: outcome === "unknown" ? 200 : 502 });
  }
  const a = answer as { sent?: number[]; notFound?: number[] } | null;
  if (!a || !Array.isArray(a.sent)) return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without saying who it sent to. Check the phones before sending again." });
  return Response.json({ verdict: "SENT", sent: a.sent, notFound: a.notFound ?? [] });
}

// ── PHOTO UPLOADS (POST admin/offers/photo-uploads, then .../register) ─────────────────────────
// Step 1 is a link and changes no record, so there is nothing to log or read back. THE LINK'S HOST IS
// CHECKED ON THE PARSED URL before the browser is told to PUT a file there: only OFFERS_UPLOAD_HOST
// passes. At release that names the S3 or CDN upload host, and the bucket needs CORS for the Clubhouse
// origin (docs/LATER.md).
export type PhotoLink = { uploadURL: string; method: string; headers: Record<string, string>; fileKey: string; expiresAt: string };
export function photoLinkProblem(link: Partial<PhotoLink>, uploadHost: string = cfg().uploadHost): string | null {
  let host = "";
  try { host = new URL(link.uploadURL ?? "").host; } catch { /* no host: refused below */ }
  if (!link.headers || typeof link.headers !== "object") return "The upload link came without its headers; nothing was uploaded.";
  if (link.method !== "PUT" || !link.fileKey || host !== uploadHost) return `The upload link was not the expected one (${link.method ?? "no method"} to ${host || "no host"}); nothing was uploaded.`;
  return null;
}
export const askPhotoLink = (auth: OffersAuth, contentType: string, sizeBytes: number) =>
  offersApiWrite<PhotoLink>(auth, "POST", `${PHOTO_UPLOADS}`, { contentType, sizeBytes });

// Step 3 is a write (the file becomes usable and its key is spent), so it goes through recordWrite.
// There is no admin read for it, so LANDED rests on the answer: a url this page would accept.
export async function registerPhoto(auth: OffersAuth, fileKey: string): Promise<Response> {
  const path = `${PHOTO_UPLOADS}/register`;
  let answer: { url?: string } | null = null;
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: "offers:photo-register", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "POST", path, body: { fileKey }, keys: [], label: (k) => k,
      applied: () => (typeof answer?.url === "string" && photoUrlOk(answer.url) ? true : "unknown"),
    },
    {
      readResource: async () => ({}),
      write: async () => { const r = await offersApiWrite<{ url?: string }>(auth, "POST", path, { fileKey }); answer = r ?? null; return r; },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  if (error) {
    const { code } = backendMessage(error);
    const text = code === "OFFER_PHOTO_INVALID" ? "That file isn't really a JPG, PNG or WebP image, so it wasn't kept."
      : code === "OFFER_PHOTO_NOT_UPLOADED" ? "The upload didn't finish. Try again."
      : code === "OFFER_PHOTO_ALREADY_USED" ? "That upload was already used. Try again."
      : errorText(error);
    return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: text }, { status: outcome === "unknown" ? 200 : 502 });
  }
  const url = (answer as { url?: string } | null)?.url;
  if (typeof url !== "string" || !photoUrlOk(url)) return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without a usable photo address. Nothing was selected." });
  return Response.json({ verdict: "LANDED", url });
}

// ── PLAYER LOOKUP (POST admin/offers/players/lookup) ───────────────────────────────────────────
// A READ the backend takes as a POST (see readAudienceCount): names, city and matches played for
// up to 20,000 ids (the page sends 2,000 per request), and the ids that are not players. Not a write, so not through recordWrite, and
// nothing about the players is logged.
export type PlayerLookup = { players: { id: number; name: string | null; type?: string; city: string | null; matchesPlayed: number }[]; notFound: number[] };
export const readPlayerLookup = (auth: OffersAuth, ids: number[]) => paced(() => {
  const { env, baseUrl } = cfg();
  return apiWrite<PlayerLookup>(env, "POST", "/admin/offers/players/lookup", { ids }, auth.actor, "offers", undefined, undefined, baseUrl);
});

// ── OFFER PUSHES (backend docs/offer-push.md) ──────────────────────────────────────────────────
// Open to anyone with Match Ops access on every environment (the OFFERS_PUSH_ACCOUNTS gate was retired 2026-11-06).
// Whether the page DRAWS the controls on production follows the backend's push mode (pushesVisible); the backend has
// no "what is your mode" route, so it is read off one campaign's push/reachable. With no campaign to ask about, the
// mode is unknown and production draws nothing until there is one.
export const pushNotFound = () => Response.json(OFFERS_NOT_FOUND, { status: 404 });
export async function readPushVisibility(campaignId: number | null): Promise<{ visible: boolean; mode: PushMode | null; env: string }> {
  const env = cfg().env;
  if (env !== "production") return { visible: true, mode: null, env };
  if (campaignId === null) return { visible: false, mode: null, env };
  const reach = await readReach(campaignId);
  const mode = reach.mode ?? null;
  return { visible: pushesVisible(env, mode), mode, env };
}

// Reads, paced like every other: who it would reach now, and how it went.
// A backend without push routes can answer them 200 with a web page (as staging did for other routes). That
// says "no pushes here", about that card alone: it is answered inside the pacer, so it does not stop every
// other offer read for 30 seconds the way a real failure does, and is thrown only once outside it.
function pushGet<T>(path: string): Promise<T> {
  const { env, baseUrl } = cfg();
  return paced(async () => {
    try { return { ok: await apiGet<T>(env, path, undefined, baseUrl) }; }
    catch (e) { if (e instanceof SyntaxError) return { none: true as const }; throw e; }
  }).then((r) => {
    if ("none" in r) { const e = new Error(`${path}: answered 200 with something that isn't JSON`); e.name = NO_PUSH_ROUTE; throw e; }
    return r.ok;
  });
}
export const readReach = (id: number) => pushGet<Reach>(`${CAMPAIGNS}/${id}/push/reachable`);
export const readPushResults = (id: number) => pushGet<PushResults>(`${CAMPAIGNS}/${id}/push/results`);
export const readPushSettings = () => pushGet<{ weeklyCap: number }>("/admin/offers/push-settings");

// THE SAVE (PUT .../push). LANDED when the campaign it returns carries the push as sent.
export function pushMismatches(want: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const p = after.push as Partial<CampaignPush> | undefined;
  if (!p || typeof p !== "object") return ["push"];
  return (["enabled", "title", "body", "sendLocal"] as const).filter((k) => k in want && (want[k] ?? null) !== (p[k] ?? null));
}
export const savePush = (auth: OffersAuth, id: number, body: Record<string, unknown>) => offersWrite({
  auth, source: "offers:push", method: "PUT", path: `${CAMPAIGNS}/${id}/push`, body, id, expect: body,
  check: (after) => pushMismatches(body, after),
});

// Why a test push could not go, in plain words: the backend's INVALID_OFFER_PUSH names the device problem in its
// message (offer-push.service.ts test: "<email> has no device to send to" / "has no device on app 1.88 or newer").
export function testPushErrorText(error: unknown, email: string): string {
  const { code, message } = backendMessage(error);
  if (code === "NOT_FOUND_PREVIEW_PLAYER") return `No player account in the app uses ${email}. Sign up in the app with that email, then try again.`;
  if (code === "OFFER_TEST_PUSH_NOT_ALLOWED") return "Test pushes are off on this backend until its push mode is live, so nothing was sent.";
  if (code === "INVALID_OFFER_PUSH" && /no device on app/i.test(message ?? "")) return `None of the phones signed in as ${email} has the MatchDay app on 1.88 or newer, so nothing was sent. Update the app on your phone, open it once, then try again.`;
  if (code === "INVALID_OFFER_PUSH" && /no device to send to/i.test(message ?? "")) return `No phone is signed in to the MatchDay app as ${email}, so nothing was sent. Sign in on your phone, then try again.`;
  return errorText(error);
}

// THE TEST PUSH (POST .../push/test): the signed-in person's own devices, and nobody else's. The backend
// takes no ids, emails or tokens, and reads who from X-Acting-Staff-Email. A 2xx is SENT, never "arrived".
export async function sendTestPush(auth: OffersAuth, id: number, text: { title?: string; body?: string }): Promise<Response> {
  const path = `${CAMPAIGNS}/${id}/push/test`;
  let answer: { pushId?: number; devices?: number; sent?: number; failed?: number } | null = null;
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: "offers:push-test", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "POST", path, body: text, keys: [], label: (k) => k,
      applied: () => (answer && typeof answer.sent === "number" ? true : "unknown"),
    },
    {
      readResource: async () => ({}),
      write: async () => { const r = await offersApiWrite<typeof answer>(auth, "POST", path, text); answer = r ?? null; return r; },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  if (error) {
    const msg = testPushErrorText(error, auth.email);
    return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: msg }, { status: outcome === "unknown" ? 200 : 502 });
  }
  const a = answer as { pushId?: number; devices?: number; sent?: number; failed?: number } | null;
  if (!a || typeof a.sent !== "number") return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without saying how many phones it sent to. Check your phone before trying again." });
  return Response.json({ verdict: "SENT", devices: a.devices ?? null, sent: a.sent, failed: a.failed ?? 0 });
}

// THE SHARED WEEKLY LIMIT (PUT /admin/offers/push-settings). It returns the settings; LANDED when they match.
export async function savePushSettings(auth: OffersAuth, weeklyCap: number): Promise<Response> {
  const path = "/admin/offers/push-settings";
  let answer: { weeklyCap?: number } | null = null;
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: "offers:push-settings", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "PUT", path, body: { weeklyCap }, keys: [], label: (k) => k,
      applied: () => (answer && typeof answer.weeklyCap === "number" ? answer.weeklyCap === weeklyCap : "unknown"),
    },
    {
      readResource: async () => ({}),
      write: async () => { const r = await offersApiWrite<{ weeklyCap?: number }>(auth, "PUT", path, { weeklyCap }); answer = r ?? null; return r; },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  if (error) return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: errorText(error) }, { status: outcome === "unknown" ? 200 : 502 });
  const a = answer as { weeklyCap?: number } | null;
  if (!a || typeof a.weeklyCap !== "number") return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without the limit. Refresh to see what it holds." });
  return Response.json({ verdict: a.weeklyCap === weeklyCap ? "LANDED" : "NOT APPLIED", weeklyCap: a.weeklyCap });
}

// ── "SHOW AGAIN" (backend 08145ea; docs/offers/M3-ENDPOINTS.md) ────────────────────────────────────────────
// The read: what a press would do now, paced like every other read.
export const readShowAgain = (id: number) => offersGet<ShowAgainPreview>(`${CAMPAIGNS}/${id}/show-again`);
// The press: POST .../show-again, bodyless, as the signed-in person. It answers { reached, campaign }, not a campaign,
// so the verdict is its own: LANDED when the campaign it returns is one round past the round the page pressed from
// (fromRound, what the page had on screen), NOT APPLIED when it isn't, UNKNOWN when no campaign came back.
export async function showAgain(auth: OffersAuth, id: number, fromRound: number): Promise<Response> {
  const path = `${CAMPAIGNS}/${id}/show-again`;
  let answer: { reached?: number; campaign?: Campaign } | null = null;
  const roundAfter = () => (answer?.campaign && typeof answer.campaign.popupRound === "number" ? answer.campaign.popupRound : null);
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: "offers:show-again", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "POST", path, body: { fromRound }, keys: ["popupRound"], label: (k) => k,
      applied: () => (roundAfter() === null ? "unknown" : roundAfter() === fromRound + 1),
    },
    {
      readResource: async () => ({ popupRound: roundAfter() ?? fromRound }),
      write: async () => { const r = await offersApiWrite<typeof answer>(auth, "POST", path, undefined); answer = r ?? null; return r; },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  if (error) return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: errorText(error) }, { status: outcome === "unknown" ? 200 : 502 });
  const a = answer as { reached?: number; campaign?: Campaign } | null;
  const after = a?.campaign ?? null;
  if (roundAfter() === null) return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without the campaign. Refresh to see whether the round moved.", after });
  if (roundAfter() !== fromRound + 1) return Response.json({ verdict: "NOT APPLIED", detail: `The backend answered with round ${roundAfter()}, not ${fromRound + 1}. Refresh and look before pressing again.`, after });
  return Response.json({ verdict: "LANDED", reached: typeof a?.reached === "number" ? a.reached : null, after });
}
