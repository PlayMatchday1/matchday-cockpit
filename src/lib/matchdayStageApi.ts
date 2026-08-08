import "server-only";

// MatchDay WRITE client. Two environments, an allowlist — NOT a switch.
//
// This is a SEPARATE module from the production READ client (matchdayApi.ts).
// Reads of production go through that one; every WRITE goes through here. Server-
// only: the `import "server-only"` makes an accidental client import a build
// error, and the credentials are non-public env vars Next.js never ships anyway.
//
// FOUR guarantees, in priority order:
//
//   1. HOST ALLOWLIST (assertAllowedHost). Two hosts, each keyed to a named
//      environment. Every call resolves the ACTUAL request URL and refuses
//      unless its PARSED host EXACTLY equals the host for the named environment.
//      Exact parsed-host match, never a substring: matchday-stage.herokuapp.com
//      .evil.com is rejected. It is an allowlist of two, not a flag that flips a
//      single constant between hosts.
//
//   2. EXPLICIT ENVIRONMENT, NO DEFAULT. Every read/write names its target
//      environment as its first argument ("staging" | "production"). There is no
//      default. `stageGet`/`stageWrite` are thin aliases that hard-say "staging"
//      and can never reach production. Code that does not say "production" cannot
//      reach production.
//
//   3. THE DENY-LIST applies to BOTH environments identically (assertNoDeniedFields
//      runs inside the shared preflight). A field dangerous on staging is
//      dangerous on production.
//
//   4. THE PRODUCTION BOLT. Production WRITES are refused outright:
//      PRODUCTION_WRITES_ENABLED is a single source constant, deliberately NOT
//      env-driven (a flag gets flipped by accident; a constant is a reviewed code
//      change). The plumbing exists — apiWrite("production", ...) resolves the
//      prod host, checks the deny-list — but the door is bolted until a later
//      phase flips this one constant. Production READS are allowed.
//
// WRITES DO NOT RETRY. This API has no Idempotency-Key, so a POST/PUT/PATCH/DELETE
// that lands server-side but returns 401/timeout must never be resent. Refresh the
// token BEFORE the call, fire exactly once; on an ambiguous outcome throw
// AmbiguousWriteError (MAY OR MAY NOT have landed). A clean 4xx is WriteFailedError
// (did not land).

export type MatchdayEnv = "staging" | "production";

// THE ALLOWLIST. Two hosts, each bound to a named environment. Compared on the
// parsed URL host, exact-equality only.
const HOSTS: Record<MatchdayEnv, string> = {
  staging: "matchday-stage.herokuapp.com",
  production: "playmatchday.herokuapp.com",
};

// THE BOLT. Flip this ONE constant (in a reviewed change, next phase) to unbolt
// production writes. Not read from env — an env flag is exactly the kind of thing
// that gets flipped by accident in a dashboard.
const PRODUCTION_WRITES_ENABLED = true;

// Env var names per environment. Staging and production credentials are wholly
// separate; the two are never crossed and production vars are never repointed.
// EVERY name encodes its environment (STAGE / PROD) so staging code can never be
// pointed at production by a generic name six months from now. There is NO
// default base URL for either environment: an unset base throws with the missing
// variable named, loudly — a silent fallback is the same failure mode as the env
// flag STEP 1 deliberately refused. The PROD write credentials live ONLY in
// .env.local (never Vercel); the deployed Clubhouse must not gain write creds.
const CRED_VARS: Record<MatchdayEnv, { base: string; email: string; password: string }> = {
  staging: { base: "MATCHDAY_STAGE_API_BASE_URL", email: "MATCHDAY_STAGE_API_EMAIL", password: "MATCHDAY_STAGE_API_PASSWORD" },
  production: { base: "MATCHDAY_PROD_BASE_URL", email: "MATCHDAY_PROD_API_EMAIL", password: "MATCHDAY_PROD_API_PASSWORD" },
};

const REFRESH_SKEW_MS = 120_000;
const WRITE_TIMEOUT_MS = 30_000;

export class StageConfigError extends Error {
  constructor(message: string) { super(message); this.name = "StageConfigError"; }
}
export class StageHostGuardError extends Error {
  constructor(message: string) { super(message); this.name = "StageHostGuardError"; }
}
export class StageAuthError extends Error {
  constructor(message: string) { super(message); this.name = "StageAuthError"; }
}
// A non-GET that was cleanly rejected before it could apply. Safe: did not land.
export class WriteFailedError extends Error {
  status: number;
  bodySnippet: string;
  constructor(status: number, message: string, bodySnippet: string) {
    super(message); this.name = "WriteFailedError"; this.status = status; this.bodySnippet = bodySnippet;
  }
}
// A non-GET whose outcome is UNKNOWN — may or may not have landed. Never retried.
export class AmbiguousWriteError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message); this.name = "AmbiguousWriteError"; this.status = status;
  }
}
// A write body naming a field that must not be written blindly. Client-level, so
// EVERY screen and BOTH environments inherit it.
export class DeniedFieldError extends Error {
  constructor(message: string) { super(message); this.name = "DeniedFieldError"; }
}
// A production write attempt while the bolt is engaged. The plumbing worked; the
// door is bolted.
export class ProductionWriteBoltedError extends Error {
  constructor(message: string) { super(message); this.name = "ProductionWriteBoltedError"; }
}
// A call to an ENDPOINT that must never be fired blindly (side effects a field
// write does not have: notifies players, destroys a match, moves money).
export class DeniedEndpointError extends Error {
  constructor(message: string) { super(message); this.name = "DeniedEndpointError"; }
}

// Fields no screen may write without a deliberate design decision. Result + teams
// array only (teams edited via PUT /admin/teams/{id}); scores are result entry.
// PHASE 7 removed startDate/endDate (the drawer owns the date pair). PHASE 13 added
// `password`: it is WRITE-ONLY on teams (Retool sends it, the GET never returns it),
// so an accidental write is undetectable AND unrestorable — a stronger reason to
// deny than the others. Applies to BOTH environments.
export const DENY_WRITE_FIELDS = new Set<string>([
  "teams", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore", "password",
]);

// Endpoints no screen may fire blindly. These have side effects a field write
// does NOT: cancel NOTIFIES every signed-up player, delete DESTROYS the match,
// refund-and-cancel MOVES MONEY. Matched on the PARSED path SHAPE (method + exact
// segment list, {id} = one wildcard segment), never a substring — so
// /admin/matches/17256/cancel-something-else is NOT caught and a trailing slash or
// ?query does not let /.../cancel slip through. Applies to BOTH environments.
const DENY_WRITE_ENDPOINTS: { method: string; segs: (string | null)[]; why: string }[] = [
  { method: "PATCH", segs: ["admin", "matches", null, "cancel"], why: "cancels the match and NOTIFIES every signed-up player (the only player-facing notification)" },
  { method: "DELETE", segs: ["admin", "matches", null], why: "permanently destroys the match" },
  { method: "PATCH", segs: ["admin", "matches", null, "players", null, "refund-and-cancel"], why: "refunds money and cancels the player (moves money)" },
];
// Parse a URL to its clean path segments: drop the query, ignore a trailing slash,
// split on "/", drop empties. Returns null if unparseable (host guard handles that).
function pathSegments(url: string): string[] | null {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return null; }
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean);
}
// Throws BEFORE any network call if (method, path) matches a denied endpoint.
export function assertAllowedEndpoint(method: string, url: string): void {
  const segs = pathSegments(url);
  if (!segs) return;
  const m = method.toUpperCase();
  for (const d of DENY_WRITE_ENDPOINTS) {
    if (d.method !== m) continue;
    if (segs.length !== d.segs.length) continue;
    if (!d.segs.every((want, i) => want === null || want === segs[i])) continue;
    const shape = "/" + d.segs.map((s) => s === null ? "{id}" : s).join("/");
    throw new DeniedEndpointError(
      `Refusing ${m} ${shape}: this endpoint ${d.why}. It is on the write client's ` +
      `endpoint deny-list and needs a deliberate decision, not a bug fix — a field ` +
      `write never reaches it.`,
    );
  }
}

// Throws BEFORE any network call if a write body names a denied field.
export function assertNoDeniedFields(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  for (const k of Object.keys(body as Record<string, unknown>)) {
    if (DENY_WRITE_FIELDS.has(k)) {
      throw new DeniedFieldError(
        `Refusing to write "${k}": it is on the write client's deny-list and needs a deliberate ` +
        `design decision, not a bug fix. (Denied set: ${[...DENY_WRITE_FIELDS].join(", ")}.)`,
      );
    }
  }
}

type Creds = { email: string; password: string; baseUrl: string };
function getCreds(env: MatchdayEnv): Creds {
  const vars = CRED_VARS[env];
  if (!vars) throw new StageConfigError(`Unknown environment ${JSON.stringify(env)}`);
  const baseUrl = process.env[vars.base]; // NO default — an unset base must throw, not fall back
  const email = process.env[vars.email];
  const password = process.env[vars.password];
  if (!baseUrl) throw new StageConfigError(`Missing ${vars.base}`);
  if (!email) throw new StageConfigError(`Missing ${vars.email}`);
  if (!password) throw new StageConfigError(`Missing ${vars.password}`);
  return { email, password, baseUrl };
}

// THE GUARD. Resolves the real host of the URL about to be fetched and refuses
// anything that is not the allowlisted host for the NAMED environment. Exact
// parsed-host equality — a spoof host that merely CONTAINS the real one is
// rejected. An unknown/unlabelled environment is refused.
export function assertAllowedHost(env: MatchdayEnv, url: string): void {
  const expected = HOSTS[env];
  if (!expected) throw new StageHostGuardError(`Refusing: unknown environment ${JSON.stringify(env)} — no host is allowlisted for it.`);
  let host: string;
  try { host = new URL(url).host; } catch { throw new StageHostGuardError(`Refusing: un-parseable URL ${JSON.stringify(url)}`); }
  if (host !== expected) {
    const otherEnv = (Object.keys(HOSTS) as MatchdayEnv[]).find((e) => HOSTS[e] === host);
    const note = otherEnv ? ` (that host is the ${otherEnv} host)` : "";
    throw new StageHostGuardError(
      `Refusing to reach host ${JSON.stringify(host)} as environment ${JSON.stringify(env)}${note}. ` +
      `Only ${expected} is allowlisted for ${env}; comparison is exact parsed-host, no substrings.`,
    );
  }
}
// Back-compat: staging-only host guard used by existing scripts.
export function assertStagingHost(url: string): void { assertAllowedHost("staging", url); }

// The exact write preflight apiWrite runs, exported so it can be asserted offline.
// Order: host allowlist -> field deny-list (both envs) -> endpoint deny-list (both
// envs) -> production bolt. All before any network call.
export function preflightWrite(env: MatchdayEnv, method: string, url: string, body: unknown): void {
  assertAllowedHost(env, url);
  assertNoDeniedFields(body);
  assertAllowedEndpoint(method, url);
  if (env === "production" && !PRODUCTION_WRITES_ENABLED) {
    throw new ProductionWriteBoltedError(
      `Refusing PRODUCTION write to ${url}: production writes are bolted (PRODUCTION_WRITES_ENABLED=false). ` +
      `The host allowlist and deny-list passed — only the bolt stands. A later phase flips one constant to unbolt.`,
    );
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean>): string {
  const url = new URL(path, baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url.toString();
}

// Read `exp` (seconds since epoch) from a JWT WITHOUT verifying the signature.
function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch { return null; }
}

// One token cache per environment — staging and production never share a token.
const cached: Partial<Record<MatchdayEnv, { token: string; expMs: number }>> = {};

async function signIn(env: MatchdayEnv): Promise<{ token: string; expMs: number }> {
  const { email, password, baseUrl } = getCreds(env);
  const url = buildUrl(baseUrl, "/auth/signin");
  assertAllowedHost(env, url); // a misconfigured base can't even authenticate off-host
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new StageAuthError(`${env} sign-in network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new StageAuthError(`${env} sign-in failed: HTTP ${res.status}. Body: ${JSON.stringify(text.slice(0, 200))}`);
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { throw new StageAuthError(`${env} sign-in returned non-JSON: ${JSON.stringify(text.slice(0, 200))}`); }
  const token = (typeof json.accessToken === "string" && json.accessToken) ||
    (typeof json.access_token === "string" && json.access_token) || null;
  if (!token) throw new StageAuthError(`${env} sign-in returned no accessToken. Keys: ${Object.keys(json).join(", ")}`);
  const expMs = jwtExpMs(token) ?? 0;
  return { token, expMs };
}

async function freshToken(env: MatchdayEnv): Promise<string> {
  const c = cached[env];
  if (c && c.expMs - Date.now() > REFRESH_SKEW_MS) return c.token;
  const t = await signIn(env);
  cached[env] = t;
  return t.token;
}

// Prove the credential + report exp / minutes-to-expiry. Defaults to staging for
// existing callers; pass an env to probe production.
export async function stageSignInProbe(env: MatchdayEnv = "staging"): Promise<{ token: string; expMs: number | null; minutesToExpiry: number | null }> {
  const t = await signIn(env);
  cached[env] = t;
  const expMs = t.expMs || null;
  return { token: t.token, expMs, minutesToExpiry: expMs ? (expMs - Date.now()) / 60000 : null };
}

// READS — env-explicit GET. Reads are safe; production reads are allowed.
export async function apiGet<T = unknown>(env: MatchdayEnv, path: string, query?: Record<string, string | number | boolean>): Promise<T> {
  const { baseUrl } = getCreds(env);
  const url = buildUrl(baseUrl, path, query);
  assertAllowedHost(env, url);
  const token = await freshToken(env);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new WriteFailedError(res.status, `GET ${url}: HTTP ${res.status}. Body: ${JSON.stringify(text.slice(0, 200))}`, text.slice(0, 200));
  return JSON.parse(text) as T;
}

// WRITES — env-explicit, single-shot, host-allowlisted, deny-listed, prod-bolted.
export async function apiWrite<T = unknown>(env: MatchdayEnv, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  // The bolt fires FIRST, before creds are even loaded — production is refused
  // regardless of whether prod credentials happen to be configured. Nothing about
  // a production write can proceed while the bolt is engaged.
  if (env === "production" && !PRODUCTION_WRITES_ENABLED) {
    throw new ProductionWriteBoltedError(
      `Refusing PRODUCTION write ${method} ${path}: production writes are bolted (PRODUCTION_WRITES_ENABLED=false). ` +
      `A later phase flips one constant to unbolt.`,
    );
  }
  const { baseUrl } = getCreds(env);
  const url = buildUrl(baseUrl, path);
  preflightWrite(env, method, url, body); // host -> field deny -> endpoint deny -> (prod bolt, already checked), all pre-network
  const token = await freshToken(env);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // Only declare a JSON content-type when there IS a body — the API rejects an
      // empty body sent with Content-Type: application/json (400). Bodyless writes
      // (DELETE a player, PATCH .../absent, PATCH .../fake-player) need no header.
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AmbiguousWriteError(
      `${method} ${url}: network error/timeout — the write MAY OR MAY NOT have landed. ` +
      `Do NOT resend; verify by hand. (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  const text = await res.text();
  if (res.ok) {
    try { return (text ? JSON.parse(text) : (undefined as T)); }
    catch { return text as unknown as T; }
  }
  if (res.status === 401 || res.status >= 500) {
    throw new AmbiguousWriteError(
      `${method} ${url}: HTTP ${res.status} — the server received this write and it MAY OR MAY NOT have landed. ` +
      `Do NOT resend; verify by hand. Body: ${JSON.stringify(text.slice(0, 200))}`,
      res.status,
    );
  }
  throw new WriteFailedError(res.status, `${method} ${url}: HTTP ${res.status} — rejected, write did not land. Body: ${JSON.stringify(text.slice(0, 200))}`, text.slice(0, 200));
}

// STAGING ALIASES — hard-say "staging"; cannot reach production. Existing callers
// (the stage route + scripts) use these unchanged.
export function stageGet<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
  return apiGet<T>("staging", path, query);
}
export function stageWrite<T = unknown>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return apiWrite<T>("staging", method, path, body);
}

export const STAGE = { STAGING_HOST: HOSTS.staging, PROD_HOST: HOSTS.production, REFRESH_SKEW_MS, HOSTS, PRODUCTION_WRITES_ENABLED };
