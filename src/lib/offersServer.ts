import "server-only";
// GROWTH › OFFERS, the server half shared by every /api/offers/* route.
//
// WHERE IT TALKS TO comes from the environment (src/lib/offersConfig.ts): OFFERS_ENV, the backend's
// base URL and the allowed upload host. Anything unset or wrong answers 503, for everyone.
//
// TWO GATES, in order: the config (503), then Match Ops access (authenticateMatchOpsRead, the same check
// the Match Ops section uses, read fresh from app_users on every request). A signed-in person without
// it gets the same answer as a route that doesn't exist (404). No session stays 401, so the page can
// tell an ended sign-in from no access. The backend's ADMIN-only rule is a separate check on the service
// account; it says nothing about which Clubhouse user is asking. Who did a write is in change_log and in
// X-Acting-Staff-Email, both from the session.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { PACE_MS } from "@/lib/matchdayApi";
import { StageConfigError, apiGet, apiWrite, WriteFailedError, type WriteActor } from "@/lib/matchdayStageApi";
import { OFFERS_NOT_FOUND } from "@/lib/offersAccess";
import { readOffersConfig, type OffersConfig, type OffersConfigResult } from "@/lib/offersConfig";
import { chicagoWallNow, offerMatchOpt, offersLogBody, photoUrlOk, pickerRange, wallFromMatch, type ApiOfferMatch, type Campaign, type City, type FieldOpt, type MatchOpt } from "@/lib/offersModel";
import { READS_STOPPED, makePacer } from "@/lib/offersPacing";
import { STAFF_NOT_ALLOWED_PLAIN, WHO_ARE_YOU, staffEmailOf, staffErrorKind } from "@/lib/staffIdentity";

export const CAMPAIGNS = "/admin/offers/campaigns";
export const MATCHES = "/admin/offers/matches";
export const PHOTO_UPLOADS = "/admin/offers/photo-uploads";

export type OffersAuth = { email: string; actor: WriteActor; supabase: SupabaseClient };

type GateDeps = { config: () => OffersConfigResult; authenticate: (req: Request) => ReturnType<typeof authenticateMatchOpsRead>; logStore: typeof supabaseLogStore };
const realDeps: GateDeps = { config: readOffersConfig, authenticate: authenticateMatchOpsRead, logStore: supabaseLogStore };
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
  const config = gateDeps.config();
  if (!config.ok) {
    console.error(`[offers] closed: ${config.problem}`);
    return Response.json({ error: "Offers isn't set up on this server." }, { status: 503 });
  }
  const auth = await gateDeps.authenticate(req);
  if (!auth.ok) return auth.status === 403 ? Response.json(OFFERS_NOT_FOUND, { status: 404 }) : Response.json({ error: auth.error }, { status: auth.status });
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
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const staff = staffErrorKind(raw);
  if (staff === "WHO") return WHO_ARE_YOU;
  if (staff === "NOT_ALLOWED") {
    console.error(`[offers] backend refused X-Acting-Staff-Email (STAFF_EMAIL_NOT_ALLOWED): ${raw.slice(0, 300)}`);
    return STAFF_NOT_ALLOWED_PLAIN;
  }
  if (e instanceof Error && e.name === READS_STOPPED) return "The backend just had a problem, so reads have stopped for a moment. Try again in 30 seconds.";
  const { code, message } = backendMessage(e);
  if (code === "OFFER_CAMPAIGN_FIELD_LOCKED") return `Those parts can't change once it has launched (${message?.split(": ")[1] ?? "locked fields"}). Nothing was saved.`;
  if (code === "INVALID_OFFER_CAMPAIGN") return `The backend refused it: ${message?.split(": ").slice(1).join(": ") || "the offer is not valid"}. Nothing was saved.`;
  if (code === "OFFER_CAMPAIGN_STATUS_CHANGE_NOT_ALLOWED") return "It can't move to that status from where it is now. Refresh to see its current status.";
  if (code === "NOT_FOUND_OFFER_CAMPAIGN") return "That offer no longer exists. Refresh the list.";
  if (e instanceof WriteFailedError && e.status === 400 && message) return `The backend refused it: ${message}. Nothing was saved.`;
  console.error(`[offers] unmapped error, shown as generic: ${raw.slice(0, 500)}`);
  return GENERIC;
}

// ── READS ───────────────────────────────────────────────────────────────────────────────────────
// The ordinary client, for single staff lookups. The page's load runs them one after another.
export function offersGet<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
  const { env, baseUrl } = cfg();
  return apiGet<T>(env, path, query, baseUrl);
}
// What fires as someone types or clicks goes through the pacer instead (src/lib/offersPacing.ts).
const paced = makePacer({ paceMs: PACE_MS, stopsOn: (e) => !(e instanceof WriteFailedError && e.status >= 400 && e.status < 500) });

export const readCampaigns = () => offersGet<Campaign[]>(CAMPAIGNS);
export async function readCampaign(id: number): Promise<Campaign | null> {
  try { return await offersGet<Campaign>(`${CAMPAIGNS}/${id}`); }
  catch (e) { if (e instanceof WriteFailedError && e.status === 404) return null; throw e; }
}

// Every city, cut down: its name, and the zone an offer's end is judged in.
export async function readCities(): Promise<City[]> {
  const r = await offersGet<{ id: number; name: string; timeZone?: { name?: string | null } | null }[]>("/admin/cities");
  return r.map((c) => ({ id: c.id, name: c.name, timeZone: c.timeZone?.name ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}

// A match from admin/matches, cut down to what the page shows. The payload carries teams[].password
// and players' details; none of it crosses to the browser. startDate is WALL CLOCK; upcoming is
// decided from startDateUtc, which is TRUE UTC.
type ApiMatch = {
  id: number; name: string; startDate: string; startDateUtc: string; isCancelled: boolean; fieldId: number | null;
  registrationPrice: number; maxPlayerCount: number; minPlayerCount: number;
  field?: { title: string; cityId: number; cover?: string | null } | null; _count?: { players: number };
};
export function matchOpt(m: ApiMatch, now = Date.now()): MatchOpt {
  return {
    id: m.id, name: m.name, startLocal: wallFromMatch(m.startDate), fieldId: m.fieldId, fieldTitle: m.field?.title ?? null, fieldCover: m.field?.cover ?? null,
    cityId: m.field?.cityId ?? null, price: m.registrationPrice, players: m._count?.players ?? 0,
    maxPlayers: m.maxPlayerCount, minPlayers: m.minPlayerCount, upcoming: !m.isCancelled && Date.parse(m.startDateUtc) > now,
  };
}
// THE MATCH LIST (GET admin/offers/matches): upcoming and not cancelled, soonest first, in the picker's
// longest range. The page's load takes ONE page of it and says whether that was all of them. Only when it
// wasn't does the panel ask for its own cities' list, walked here through the pacer, stopping at the
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
    const r = await paced(() => matchPage(page, cityIds));
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
export type AudienceCount = { count: number; heldBack: number; players: number; mostItCanCost: number | null };
export const readAudienceCount = (auth: OffersAuth, body: Record<string, unknown>) => paced(() => {
  const { env, baseUrl } = cfg();
  return apiWrite<AudienceCount>(env, "POST", `${CAMPAIGNS}/audience-count`, body, auth.actor, "offers", undefined, undefined, baseUrl);
});

// Every field, cut down to what the photo picker and Played at need (title, city, cover URL).
type ApiField = { id: number; title: string; cityId: number | null; cover?: string | null; deletedAt?: string | null };
export async function readFields(): Promise<FieldOpt[]> {
  const r = await offersGet<ApiField[] | { data: ApiField[] }>("/admin/fields");
  return (Array.isArray(r) ? r : r.data ?? []).filter((f) => !f.deletedAt)
    .map((f) => ({ id: f.id, title: f.title, cityId: f.cityId ?? null, cover: f.cover ?? null }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// One match, read when an offer that names it is opened (GET /api/offers/matches/{id}), never on page load.
export const readMatch = async (id: number): Promise<MatchOpt> => matchOpt(await offersGet<ApiMatch>(`/admin/matches/${id}`));

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────
// One request, never retried, through recordWrite (which stores nothing in local mode). The answer
// comes from OUR OWN read after the write, compared with what the write meant to leave behind:
// LANDED / FAILED / NOT APPLIED / UNKNOWN. A 2xx alone is never reported as landed.
export type Verdict = "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN";

export function offersApiWrite<T = unknown>(auth: OffersAuth, method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const staff = staffEmailOf(auth.email);
  if (!staff) return Promise.reject(new Error(WHO_ARE_YOU));
  const { env, baseUrl } = cfg();
  return apiWrite<T>(env, method, path, body, auth.actor, "offers", undefined, staff, baseUrl);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Id sets: the backend may store them in its own order (playerIds come back sorted), and order means nothing.
const ID_SETS = new Set(["cityIds", "fieldIds", "playerIds"]);
const sortedIds = (v: unknown) => (Array.isArray(v) ? [...v].sort((x, y) => Number(x) - Number(y)) : v);
export function mismatches(expected: Record<string, unknown>, after: Record<string, unknown> | null): string[] {
  if (!after) return Object.keys(expected);
  return Object.keys(expected).filter((k) => (ID_SETS.has(k) ? !same(sortedIds(expected[k]), sortedIds(after[k])) : !same(expected[k], after[k])));
}

export type WriteResult = { verdict: Verdict; after: Campaign | null; error?: string; detail?: string };

export async function offersWrite(opts: {
  auth: OffersAuth; source: string; method: "POST" | "PATCH" | "DELETE"; path: string;
  // undefined = a bodyless write (launch, pause, end): no body and no content-type, which the
  // backend requires (Fastify rejects an empty JSON body).
  body?: Record<string, unknown>;
  // The campaign the write is about, or null for a create (read by the id the response carries).
  id: number | null;
  expect: Record<string, unknown>;
  // A delete: LANDED only when the read-back finds no campaign at all.
  expectGone?: boolean;
}): Promise<WriteResult> {
  let createdId: number | null = opts.id;
  const read = async () => (createdId === null ? null : await readCampaign(createdId));
  const { outcome, error } = await recordWrite(
    {
      env: cfg().env, source: opts.source, actorName: opts.auth.email, actorEmail: opts.auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: opts.method, path: opts.path,
      body: offersLogBody(opts.body ?? {}), keys: Object.keys(opts.expect), label: (k) => k,
      applied: (_b, after) => (opts.expectGone ? after.missing === true : mismatches(opts.expect, after).length === 0),
    },
    {
      readResource: async () => ((await read()) as unknown as Record<string, unknown>) ?? { missing: true },
      write: async () => {
        const r = await offersApiWrite<Record<string, unknown>>(opts.auth, opts.method, opts.path, opts.body);
        if (createdId === null && r && typeof r === "object" && typeof r.id === "number") createdId = r.id;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    gateDeps.logStore(),
  );
  const after = await read().catch(() => undefined);
  const missing = mismatches(opts.expect, (after ?? null) as unknown as Record<string, unknown> | null);
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
      applied: () => answer !== null && Array.isArray(answer.sent),
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
      applied: () => typeof answer?.url === "string",
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
// up to 2000 ids, and the ids that are not players. Not a write, so not through recordWrite, and
// nothing about the players is logged.
export type PlayerLookup = { players: { id: number; name: string | null; city: string | null; matchesPlayed: number }[]; notFound: number[] };
export const readPlayerLookup = (auth: OffersAuth, ids: number[]) => paced(() => {
  const { env, baseUrl } = cfg();
  return apiWrite<PlayerLookup>(env, "POST", "/admin/offers/players/lookup", { ids }, auth.actor, "offers", undefined, undefined, baseUrl);
});
