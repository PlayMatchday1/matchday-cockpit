import "server-only";
// GROWTH › OFFERS, the server half shared by every /api/offers/* route.
//
// LOCAL ONLY FOR NOW. admin/offers/campaigns exists only on the local backend (feature/offers on
// localhost:3070), so every route here talks to the "local" target of the write client and answers
// 503 unless local mode is on. When the backend ships, the target changes in ONE place (OFFERS_ENV).
//
// THREE GATES, in order, each on top of the last: local mode (503), admin (authenticateAdmin, read
// fresh from app_users on every request), OFFERS_ALLOWLIST (404). The backend's ADMIN-only rule is a
// separate check on the service account; it says nothing about which Clubhouse user is asking.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { localModeOn } from "@/lib/localMode";
import { apiGet, apiWrite, WriteFailedError, type ClientEnv, type WriteActor } from "@/lib/matchdayStageApi";
import { OFFERS_NOT_FOUND, onOffersAllowlist } from "@/lib/offersAccess";
import { wallFromMatch, type Campaign, type MatchOpt } from "@/lib/offersModel";
import { STAFF_NOT_ALLOWED_PLAIN, WHO_ARE_YOU, staffEmailOf, staffErrorKind } from "@/lib/staffIdentity";

export const OFFERS_ENV: ClientEnv = "local";
export const CAMPAIGNS = "/admin/offers/campaigns";

export type OffersAuth = { email: string; actor: WriteActor; supabase: SupabaseClient };

type GateDeps = { localModeOn: () => boolean; authenticateAdmin: (req: Request) => ReturnType<typeof authenticateAdmin> };
const realDeps: GateDeps = { localModeOn, authenticateAdmin };
let gateDeps: GateDeps = realDeps;
// FOR scripts/offers-model-test.ts ONLY: run the real gate as each kind of caller, offline.
export function _setOffersGateDepsForTest(d: Partial<GateDeps> | null) { gateDeps = d ? { ...realDeps, ...d } : realDeps; }

export async function offersGate(req: Request): Promise<OffersAuth | Response> {
  if (!gateDeps.localModeOn()) {
    return Response.json({ error: "Offers runs against the local backend only, and local mode is off (MATCHDAY_LOCAL_API=1 under next dev)." }, { status: 503 });
  }
  const auth = await gateDeps.authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!onOffersAllowlist(auth.email)) return Response.json(OFFERS_NOT_FOUND, { status: 404 });
  // Every write carries the session's person; without a usable email it is refused here, before the backend.
  if (req.method !== "GET" && !staffEmailOf(auth.email)) return Response.json({ error: WHO_ARE_YOU }, { status: 401 });
  return { email: auth.email, supabase: auth.supabase, actor: { canEditMatches: false, isAdmin: true, email: auth.email, userId: auth.appUserId } };
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
export const readCampaigns = () => apiGet<Campaign[]>(OFFERS_ENV, CAMPAIGNS);
export async function readCampaign(id: number): Promise<Campaign | null> {
  try { return await apiGet<Campaign>(OFFERS_ENV, `${CAMPAIGNS}/${id}`); }
  catch (e) { if (e instanceof WriteFailedError && e.status === 404) return null; throw e; }
}

// A match from admin/matches, cut down to what the page shows. The payload carries teams[].password
// and players' details; none of it crosses to the browser. startDate is WALL CLOCK; upcoming is
// decided from startDateUtc, which is TRUE UTC.
type ApiMatch = {
  id: number; name: string; startDate: string; startDateUtc: string; isCancelled: boolean; fieldId: number | null;
  registrationPrice: number; maxPlayerCount: number; minPlayerCount: number;
  field?: { title: string; cityId: number } | null; _count?: { players: number };
};
export function matchOpt(m: ApiMatch, now = Date.now()): MatchOpt {
  return {
    id: m.id, name: m.name, startLocal: wallFromMatch(m.startDate), fieldId: m.fieldId, fieldTitle: m.field?.title ?? null,
    cityId: m.field?.cityId ?? null, price: m.registrationPrice, players: m._count?.players ?? 0,
    maxPlayers: m.maxPlayerCount, minPlayers: m.minPlayerCount, upcoming: !m.isCancelled && Date.parse(m.startDateUtc) > now,
  };
}
type Page<T> = { page: number; limit: number; totalItems: number; data: T[] };
// Every page of the upcoming list (the backend's default fromDate is today, UTC). Local, single-writer
// backend, so paging is sound here.
export async function readUpcomingMatches(): Promise<MatchOpt[]> {
  const out: ApiMatch[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await apiGet<Page<ApiMatch>>(OFFERS_ENV, "/admin/matches", { page, limit: 100 });
    out.push(...(r.data ?? []));
    if (!r.data?.length || out.length >= r.totalItems) break;
  }
  return out.map((m) => matchOpt(m)).filter((m) => m.upcoming).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
}
// THE LIVE COUNT (POST admin/offers/campaigns/audience-count). A READ that the backend takes as a
// POST: it goes through the guarded write client (host check, local target only) because that is the
// client that can POST, but it changes nothing, so it is not put through recordWrite and carries no
// staff header. It lives here rather than in its route so write-routes-logged-test keeps meaning
// "every apiWrite in a route is a logged write".
export type AudienceCount = { count: number; heldBack: number; players: number; mostItCanCost: number | null };
export const readAudienceCount = (auth: OffersAuth, body: Record<string, unknown>) =>
  apiWrite<AudienceCount>(OFFERS_ENV, "POST", `${CAMPAIGNS}/audience-count`, body, auth.actor, "admin");

// A campaign's match that is no longer upcoming, read one by one so its label still shows.
export async function readMatch(id: number): Promise<MatchOpt | null> {
  try { return matchOpt(await apiGet<ApiMatch>(OFFERS_ENV, `/admin/matches/${id}`)); } catch { return null; }
}

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────
// One request, never retried, through recordWrite (which stores nothing in local mode). The answer
// comes from OUR OWN read after the write, compared with what the write meant to leave behind:
// LANDED / FAILED / NOT APPLIED / UNKNOWN. A 2xx alone is never reported as landed.
export type Verdict = "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN";

export function offersApiWrite<T = unknown>(auth: OffersAuth, method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const staff = staffEmailOf(auth.email);
  if (!staff) return Promise.reject(new Error(WHO_ARE_YOU));
  return apiWrite<T>(OFFERS_ENV, method, path, body, auth.actor, "admin", undefined, staff);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function mismatches(expected: Record<string, unknown>, after: Record<string, unknown> | null): string[] {
  if (!after) return Object.keys(expected);
  return Object.keys(expected).filter((k) => !same(expected[k], after[k]));
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
      env: OFFERS_ENV, source: opts.source, actorName: opts.auth.email, actorEmail: opts.auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: opts.method, path: opts.path,
      body: opts.body ?? {}, keys: Object.keys(opts.expect), label: (k) => k,
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
    supabaseLogStore(),
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

// ── SEND TO MY PHONE (POST admin/offers/campaigns/{id}/send-to-me) ─────────────────────────────
// The popup goes to the player account with the staff person's own email, on its next app open.
// Nothing in the admin API reads a preview back, so a 2xx is reported as SENT (the backend took
// it), never LANDED and never "arrived": whether it reached the phone is checked on the phone.
// It is a write (it stores a preview), so it goes through recordWrite like the rest.
export async function sendToMe(auth: OffersAuth, id: number): Promise<Response> {
  const path = `${CAMPAIGNS}/${id}/send-to-me`;
  let popup: unknown = null;
  const { outcome, error } = await recordWrite(
    {
      env: OFFERS_ENV, source: "offers:send-to-me", actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null, method: "POST", path, body: {}, keys: [], label: (k) => k,
      applied: () => popup !== null,
    },
    {
      readResource: async () => ({}),
      write: async () => {
        const r = await offersApiWrite<{ userId?: number; popup?: unknown }>(auth, "POST", path);
        popup = r?.popup ?? null;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  if (error) {
    const { code } = backendMessage(error);
    const text = code === "NOT_FOUND_PREVIEW_PLAYER"
      ? `No player account in the app uses ${auth.email}. Sign up in the app with that email, then send it again.`
      : errorText(error);
    return Response.json({ verdict: outcome === "unknown" ? "UNKNOWN" : "FAILED", error: text }, { status: outcome === "unknown" ? 200 : 502 });
  }
  if (popup === null) return Response.json({ verdict: "UNKNOWN", detail: "The backend answered without the popup it says it sends. Check your phone before sending again." });
  return Response.json({ verdict: "SENT" });
}
