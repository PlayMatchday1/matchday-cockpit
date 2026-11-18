// THE MATCHDAY API GATE (Ryan, 2026-11-18). The ONE place in Clubhouse that sends a request to the
// MatchDay API. matchdayApi.ts (the read client and the paced client) and matchdayStageApi.ts
// (apiGet, apiWrite, sign-in) call mdapiFetch instead of fetch; nothing else may reach the API
// (scripts/mdapi-gate-guard-test.ts fails the build otherwise).
//
// WHY. On 2026-11-17 the warm cron fired up to ~400 parallel GET /admin/matches and ran the API (one
// 1 GB Heroku dyno) out of memory. Every limit Clubhouse had lived inside one process, and Vercel runs
// many processes, so nothing capped the total.
//
// WHAT IT DOES, for every PRODUCTION request. Three lanes, so one kind of traffic never takes another's
// room: write 2 — staff writes; staff 6 — what a person is waiting on; bulk 1 — every cron and sync.
//   1. BULK IS GLOBAL. Every cron, sync and night-pass request takes the ONE bulk slot in Supabase
//      (0275): one at a time across all of Vercel, every instance together. A slot is a lease that
//      frees itself if the function dies holding it. The SHARED BREAKER (also 0275): a failed bulk read
//      (5xx, 429, timeout, network) stops every sync for 15, then 30, 60, 120 minutes.
//   2. STAFF AND WRITES ARE PER INSTANCE (Ryan, 2026-11-18). Taking a Supabase slot costs ~40 ms
//      from a production function (measured: p50 38-43 ms, p95 59-67 ms, iad1, 90 round trips), over
//      the 20 ms a staff screen may pay. So a staff read or a write waits only for this instance's own
//      cap (6 and 2), with no network call. Staff reads have a breaker of their own in this instance:
//      the third failure in a row stops staff reads here for 15 s, then 30, 60, 120 s. Writes are never
//      stopped by a breaker. Revisit (Upstash, same region) only if staff traffic grows or an alert
//      shows a staff-driven spike.
//   3. A TIMEOUT on every request: staff reads 15 s, bulk reads 30 s (a promocodes page of 1000 is
//      slow), writes 30 s (unchanged).
//   4. IN-FLIGHT DEDUPE: identical GETs (same env and URL) running at the same time in this instance
//      share one request. Nothing is cached once it answers — a read that starts after another
//      finished goes to the API, so a read before a write is never served an old copy.
// Retries are the caller's (matchdayApi.ts: staff reads at most one, bulk none; writes never).
//
// IF SUPABASE CANNOT BE REACHED: bulk requests stop, because a sync can wait for the next run. Staging
// and the local backend bypass the slots — they are not the production dyno — but keep the timeout and
// the dedupe.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type MdapiLane = "write" | "staff" | "bulk";
export type MdapiGateEnv = "production" | "staging" | "local" | "other";

export const LANE_SIZE: Record<MdapiLane, number> = { write: 2, staff: 6, bulk: 1 };
export const TIMEOUT_MS: Record<MdapiLane, number> = { write: 30_000, staff: 15_000, bulk: 30_000 };
/** How long a request waits for a free slot before giving up. */
export const MAX_WAIT_MS: Record<MdapiLane, number> = { write: 10_000, staff: 10_000, bulk: 90_000 };
/** Breaker steps in seconds, by failures in a row. 0 = not open yet. */
export const BREAKER_STEPS_S: Record<"staff" | "bulk", number[]> = {
  staff: [0, 0, 15, 30, 60, 120],
  bulk: [900, 1800, 3600, 7200],
};

export class MdapiGateClosedError extends Error {
  constructor(public lane: MdapiLane, public until: string, url: string) {
    super(`MatchDay API ${lane} lane is paused until ${until} after failed reads; no request was sent (${labelOf(url)})`);
    this.name = "MdapiGateClosedError";
  }
}
export class MdapiGateBusyError extends Error {
  constructor(public lane: MdapiLane, waitedMs: number, url: string) {
    super(`MatchDay API ${lane} lane stayed full for ${Math.round(waitedMs / 1000)} s; no request was sent (${labelOf(url)})`);
    this.name = "MdapiGateBusyError";
  }
}
export class MdapiTimeoutError extends Error {
  constructor(public lane: MdapiLane, ms: number, url: string) {
    super(`MatchDay API did not answer within ${ms / 1000} s (${labelOf(url)})`);
    this.name = "MdapiTimeoutError";
  }
}

/* ── WHICH LANE ─────────────────────────────────────────────────────────────────────────────────────
 * Writes say so themselves (apiWrite). Reads are "staff" unless the code around them runs as bulk:
 * the paced client, and every cron route through withMdapiLane("bulk", ...). */
const laneStore = new AsyncLocalStorage<MdapiLane>();
export function withMdapiLane<T>(lane: MdapiLane, f: () => Promise<T>): Promise<T> {
  return laneStore.run(lane, f);
}
export function currentLane(): MdapiLane {
  return laneStore.getStore() ?? "staff";
}

/** The env a URL belongs to, from its PARSED host. Anything unknown gets no slot (it is not the dyno). */
export function envOfUrl(url: string): MdapiGateEnv {
  let host = "";
  try { host = new URL(url).host; } catch { return "other"; }
  if (host === "playmatchday.herokuapp.com") return "production";
  if (host === "matchday-stage.herokuapp.com") return "staging";
  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) return "local";
  return "other";
}

/** The endpoint pattern, never a player id: '/admin/players/123?x=1' -> '/admin/players/:n'. */
export function labelOf(url: string): string {
  try { return new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/:n"); } catch { return "?"; }
}

/* ── THE SLOT STORE ─────────────────────────────────────────────────────────────────────────────────
 * An interface so it can move to Redis without touching the transports. */
export interface SlotStore {
  /** null = no store in this process (the guards, a build): use this process's own cap, quietly. */
  acquire(env: MdapiGateEnv, lane: MdapiLane, holder: string, label: string, leaseMs: number): Promise<{ slot: number | null; openUntil: string | null; failures: number } | null>;
  release(lane: MdapiLane, slot: number, holder: string): Promise<void>;
  report(env: MdapiGateEnv, lane: "staff" | "bulk", ok: boolean, error: string): Promise<void>;
}

let sb: SupabaseClient | null | undefined;
function supabase(): SupabaseClient | null {
  if (sb !== undefined) return sb;
  // The node guards (scripts/run-suites.mjs) run with the store off: they mock fetch and must never
  // take a real slot. A local script run by hand keeps it on, so it shares the production cap too.
  if (process.env.MDAPI_GATE_STORE === "off") return (sb = null);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  sb = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return sb;
}

const supabaseStore: SlotStore = {
  async acquire(env, lane, holder, label, leaseMs) {
    const c = supabase();
    if (!c) return null;
    const { data, error } = await c.rpc("mdapi_gate_acquire", { p_env: env, p_lane: lane, p_holder: holder, p_label: label, p_lease_ms: leaseMs });
    if (error) throw new Error(`mdapi_gate_acquire: ${error.message}`);
    const d = (data ?? {}) as { slot?: number | null; open_until?: string | null; failures?: number };
    return { slot: d.slot ?? null, openUntil: d.open_until ?? null, failures: d.failures ?? 0 };
  },
  async release(lane, slot, holder) {
    const c = supabase();
    if (!c) return;
    const { error } = await c.rpc("mdapi_gate_release", { p_lane: lane, p_slot: slot, p_holder: holder });
    if (error) throw new Error(`mdapi_gate_release: ${error.message}`);
  },
  async report(env, lane, ok, err) {
    const c = supabase();
    if (!c) return;
    const { error } = await c.rpc("mdapi_gate_report", { p_env: env, p_lane: lane, p_ok: ok, p_error: err.slice(0, 200), p_steps_s: BREAKER_STEPS_S[lane] });
    if (error) throw new Error(`mdapi_gate_report: ${error.message}`);
  },
};

/* ── TEST SEAMS ── */
type Deps = { store: SlotStore; fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number; log: (line: string) => void; timeouts: Record<MdapiLane, number> };
const realDeps: Deps = {
  store: supabaseStore,
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (line) => console.log(line),
  timeouts: TIMEOUT_MS,
};
let deps: Deps = realDeps;
export function __setGateDepsForTest(d: Partial<Deps>): () => void {
  deps = { ...realDeps, ...d };
  return () => { deps = realDeps; inflight.clear(); staffBreaker.clear(); for (const l of Object.keys(local) as MdapiLane[]) local[l] = 0; };
}

/* ── THIS INSTANCE'S OWN CAP (used only when the slot store cannot be reached) ── */
const local: Record<MdapiLane, number> = { write: 0, staff: 0, bulk: 0 };
async function localSlot(lane: MdapiLane, deadline: number, url: string): Promise<() => void> {
  for (let wait = 25; local[lane] >= LANE_SIZE[lane]; wait = Math.min(wait * 2, 250)) {
    if (deps.now() > deadline) throw new MdapiGateBusyError(lane, MAX_WAIT_MS[lane], url);
    await deps.sleep(wait);
  }
  local[lane]++;
  let done = false;
  return () => { if (!done) { done = true; local[lane]--; } };
}

/** Counters for this instance, for the log line a cron writes at the end of a run. */
export const gateStats = { requests: 0, waitedMs: 0, storeDown: 0, deduped: 0 };

/** Take a global slot (production only). Returns the release function and the lane's failure count. */
/** The lanes that take a GLOBAL slot. Staff and write use this instance's cap (no network call). */
export const GLOBAL_LANES: ReadonlySet<MdapiLane> = new Set<MdapiLane>(["bulk"]);

/* ── STAFF READS: THIS INSTANCE'S BREAKER ── */
const staffBreaker = new Map<MdapiGateEnv, { failures: number; until: number }>();
function staffOpenUntil(env: MdapiGateEnv): number | null {
  const b = staffBreaker.get(env);
  return b && b.until > deps.now() ? b.until : null;
}
function staffReport(env: MdapiGateEnv, ok: boolean): void {
  if (ok) { staffBreaker.delete(env); return; }
  const failures = (staffBreaker.get(env)?.failures ?? 0) + 1;
  const steps = BREAKER_STEPS_S.staff;
  const s = steps[Math.min(failures - 1, steps.length - 1)];
  staffBreaker.set(env, { failures, until: s > 0 ? deps.now() + s * 1000 : 0 });
}

async function takeSlot(env: MdapiGateEnv, lane: MdapiLane, url: string): Promise<{ release: () => Promise<void> | void; failures: number }> {
  if (!GLOBAL_LANES.has(lane)) {
    if (lane === "staff") {
      const u = staffOpenUntil(env);
      if (u) throw new MdapiGateClosedError(lane, new Date(u).toISOString(), url);
    }
    return { release: await localSlot(lane, deps.now() + MAX_WAIT_MS[lane], url), failures: 0 };
  }
  const start = deps.now();
  const deadline = start + MAX_WAIT_MS[lane];
  const holder = randomUUID();
  const label = labelOf(url);
  const leaseMs = deps.timeouts[lane] + 5_000;
  for (let wait = 25; ; wait = Math.min(wait * 2, 400)) {
    let r: Awaited<ReturnType<SlotStore["acquire"]>>;
    try {
      r = await deps.store.acquire(env, lane, holder, label, leaseMs);
    } catch (e) {
      gateStats.storeDown++;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`MatchDay gate: the slot store could not be reached, so this sync sent nothing (${msg})`);
    }
    if (r === null) return { release: await localSlot(lane, deadline, url), failures: 0 };
    if (r.openUntil) throw new MdapiGateClosedError(lane, r.openUntil, url);
    if (r.slot != null) {
      const slot = r.slot;
      gateStats.waitedMs += deps.now() - start;
      let done = false;
      return {
        failures: r.failures,
        // Awaited: a sync does not mind 40 ms, and the ONE bulk slot must not wait out a lease because
        // a function froze before an unawaited release ran. A failed release still frees itself when
        // the lease ends.
        release: async () => {
          if (done) return;
          done = true;
          await deps.store.release(lane, slot, holder).catch((e) => deps.log(`[mdapi-gate] release failed (lease will expire): ${e instanceof Error ? e.message : e}`));
        },
      };
    }
    if (deps.now() + wait > deadline) throw new MdapiGateBusyError(lane, deps.now() - start, url);
    await deps.sleep(wait);
  }
}

/** A failure the breaker counts: the API is struggling, not refusing this one request. */
export function isStrainFailure(status: number | null): boolean {
  return status == null || status === 429 || status >= 500;
}

const inflight = new Map<string, Promise<{ status: number; headers: Headers; text: string }>>();

export type MdapiResponse = { status: number; ok: boolean; headers: Headers; text: string };

/**
 * Send one request to the MatchDay API. The body is read here (text), so the slot is held for exactly
 * the time the API is working on it. Throws MdapiGateClosedError / MdapiGateBusyError before sending,
 * MdapiTimeoutError on a timeout, and the fetch error on a network failure. Never retries.
 */
export async function mdapiFetch(url: string, init: RequestInit & { method?: string } = {}, opts: { lane?: MdapiLane } = {}): Promise<MdapiResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const lane: MdapiLane = method === "GET" ? (opts.lane ?? currentLane()) : (opts.lane ?? "write");
  const env = envOfUrl(url);
  const key = method === "GET" ? `${env} ${url} ${authKey(init.headers)}` : null;
  if (key) {
    const joined = inflight.get(key);
    if (joined) {
      gateStats.deduped++;
      const r = await joined;
      return { ...r, ok: r.status >= 200 && r.status < 300 };
    }
  }
  const run = send(env, lane, url, init);
  if (key) {
    inflight.set(key, run);
    run.then(() => inflight.delete(key), () => inflight.delete(key));
  }
  const r = await run;
  return { ...r, ok: r.status >= 200 && r.status < 300 };
}

/** Two callers with different tokens are not the same request (a re-sign-in mid-flight). */
function authKey(h: HeadersInit | undefined): string {
  if (!h) return "";
  const v = h instanceof Headers ? h.get("authorization") : Array.isArray(h) ? h.find(([k]) => k.toLowerCase() === "authorization")?.[1] : (h as Record<string, string>).Authorization ?? (h as Record<string, string>).authorization;
  return v ? String(v).slice(-16) : "";
}

async function send(env: MdapiGateEnv, lane: MdapiLane, url: string, init: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const gated = env === "production";
  const slot = gated ? await takeSlot(env, lane, url) : null;
  gateStats.requests++;
  const ms = deps.timeouts[lane];
  let status: number | null = null;
  let failure = "";
  try {
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      failure = timedOut ? `timeout after ${ms / 1000} s` : `network: ${e instanceof Error ? e.message : String(e)}`;
      throw timedOut ? new MdapiTimeoutError(lane, ms, url) : e;
    }
    status = res.status;
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      failure = `body read failed: ${e instanceof Error ? e.message : String(e)}`;
      status = null;
      throw e;
    }
    if (isStrainFailure(status)) failure = `HTTP ${status}`;
    return { status: res.status, headers: res.headers, text };
  } finally {
    await slot?.release();
    // The breaker hears about reads only: a write's outcome is its own (and never retried).
    if (gated && lane === "staff") staffReport(env, !failure);
    if (gated && lane === "bulk") {
      if (failure) {
        deps.store.report(env, lane, false, `${labelOf(url)}: ${failure}`)
          .catch((e) => deps.log(`[mdapi-gate] breaker report failed: ${e instanceof Error ? e.message : e}`));
      } else if (slot && slot.failures > 0) {
        deps.store.report(env, lane, true, "")
          .catch((e) => deps.log(`[mdapi-gate] breaker report failed: ${e instanceof Error ? e.message : e}`));
      }
    }
  }
}
