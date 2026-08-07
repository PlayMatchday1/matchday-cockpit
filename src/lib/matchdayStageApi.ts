import "server-only";

// STAGING-ONLY MatchDay write client. Physically cannot write to production.
//
// This is a SEPARATE module from the production read client (matchdayApi.ts)
// with SEPARATE credentials (MATCHDAY_STAGE_API_*). The two are never crossed:
// prod stays read-only through matchdayApi.ts; every write goes through here and
// here only. Server-only — the `import "server-only"` above makes an accidental
// client import a build error, and MATCHDAY_STAGE_API_PASSWORD is a non-public
// env var that Next.js would never ship to the browser regardless.
//
// THREE guarantees, in priority order:
//
//   1. HOST GUARD (assertStagingHost). Every non-GET resolves the ACTUAL request
//      URL and refuses unless its host === matchday-stage.herokuapp.com. It
//      compares the real host, not a boolean flag or env toggle — a flag gets
//      flipped by accident; a host string that isn't the staging host cannot be
//      "accidentally staging". If the base URL is production, the write throws
//      before any network call.
//
//   2. WRITES DO NOT RETRY. Reads may be retried safely; a write must not. This
//      API has NO Idempotency-Key, so a POST/PUT/PATCH/DELETE that lands
//      server-side but returns 401 or times out must never be resent — a retry
//      would double-apply. So: refresh the token BEFORE the call when it is near
//      expiry (to avoid a mid-write 401), then fire exactly once. On an
//      ambiguous outcome (network error, timeout, 401, or 5xx — the cases where
//      the server may already have applied the change) throw AmbiguousWriteError,
//      which says in words that the write MAY OR MAY NOT have landed and needs a
//      human to check. A clean 4xx (400/403/404/409/422) is a definitive
//      rejection: WriteFailedError, the write did not land.
//
//   3. FRESH TOKEN. The access token's `exp` is read from the JWT and the token
//      is re-minted before it lapses, so writes don't fail on a stale token.

const STAGING_HOST = "matchday-stage.herokuapp.com";
const PROD_HOST = "playmatchday.herokuapp.com";
// Re-mint the token if it is within this window of expiring, so a write never
// races the expiry. Also the floor we treat "no exp claim" as (always re-mint).
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
// A non-GET whose outcome is UNKNOWN — the change may or may not have landed.
// Never retried. Must be reconciled by hand.
export class AmbiguousWriteError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message); this.name = "AmbiguousWriteError"; this.status = status;
  }
}

type Creds = { email: string; password: string; baseUrl: string };
function getCreds(): Creds {
  const email = process.env.MATCHDAY_STAGE_API_EMAIL;
  const password = process.env.MATCHDAY_STAGE_API_PASSWORD;
  const baseUrl = process.env.MATCHDAY_STAGE_API_BASE_URL;
  if (!baseUrl) throw new StageConfigError("Missing MATCHDAY_STAGE_API_BASE_URL");
  if (!email) throw new StageConfigError("Missing MATCHDAY_STAGE_API_EMAIL");
  if (!password) throw new StageConfigError("Missing MATCHDAY_STAGE_API_PASSWORD");
  return { email, password, baseUrl };
}

// THE GUARD. Resolves the real host of the URL about to be fetched and refuses
// anything that is not the staging host. Called before every non-GET.
export function assertStagingHost(url: string): void {
  let host: string;
  try { host = new URL(url).host; } catch { throw new StageHostGuardError(`Refusing write: un-parseable URL ${JSON.stringify(url)}`); }
  if (host !== STAGING_HOST) {
    const prod = host === PROD_HOST ? " That is PRODUCTION." : "";
    throw new StageHostGuardError(
      `Refusing to send a write to host ${JSON.stringify(host)} — writes are staging-only ` +
      `(${STAGING_HOST}).${prod} No env flag can override this; it compares the resolved host.`,
    );
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean>): string {
  const url = new URL(path, baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url.toString();
}

// Read `exp` (seconds since epoch) from a JWT WITHOUT verifying the signature —
// we only need it to schedule re-mint, never to trust the token's contents.
function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch { return null; }
}

let cached: { token: string; expMs: number } | null = null;

// Sign in to STAGING. Host-guarded too: a misconfigured base URL cannot even
// authenticate against production. Returns the token + its parsed expiry.
async function signIn(): Promise<{ token: string; expMs: number }> {
  const { email, password, baseUrl } = getCreds();
  const url = buildUrl(baseUrl, "/auth/signin");
  assertStagingHost(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new StageAuthError(`Staging sign-in network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new StageAuthError(`Staging sign-in failed: HTTP ${res.status}. Body: ${JSON.stringify(text.slice(0, 200))}`);
  }
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { throw new StageAuthError(`Staging sign-in returned non-JSON: ${JSON.stringify(text.slice(0, 200))}`); }
  const token = (typeof json.accessToken === "string" && json.accessToken) ||
    (typeof json.access_token === "string" && json.access_token) || null;
  if (!token) throw new StageAuthError(`Staging sign-in returned no accessToken. Keys: ${Object.keys(json).join(", ")}`);
  const expMs = jwtExpMs(token) ?? 0; // 0 → treat as immediately-stale (always re-mint)
  return { token, expMs };
}

async function freshToken(): Promise<string> {
  if (cached && cached.expMs - Date.now() > REFRESH_SKEW_MS) return cached.token;
  cached = await signIn();
  return cached.token;
}

// Expose the token's expiry so a script can prove the credential + report the
// exp / minutes-to-expiry without duplicating the sign-in logic.
export async function stageSignInProbe(): Promise<{ token: string; expMs: number | null; minutesToExpiry: number | null }> {
  const t = await signIn();
  cached = t;
  const expMs = t.expMs || null;
  return { token: t.token, expMs, minutesToExpiry: expMs ? (expMs - Date.now()) / 60000 : null };
}

// READS — staging GET. Reads are safe; single attempt kept simple.
export async function stageGet<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
  const { baseUrl } = getCreds();
  const url = buildUrl(baseUrl, path, query);
  const token = await freshToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new WriteFailedError(res.status, `GET ${url}: HTTP ${res.status}. Body: ${JSON.stringify(text.slice(0, 200))}`, text.slice(0, 200));
  return JSON.parse(text) as T;
}

// WRITES — single-shot, host-guarded, never retried.
export async function stageWrite<T = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const { baseUrl } = getCreds();
  const url = buildUrl(baseUrl, path);
  assertStagingHost(url); // GUARD FIRST — before token, before network.
  const token = await freshToken(); // refresh-before to avoid a mid-write 401.

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (e) {
    // Network error or timeout: the request may have reached the server and
    // applied. NOT retried — surface the ambiguity.
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
  // 401 or 5xx: the server received the request; it may have applied before the
  // error. Ambiguous — never retried.
  if (res.status === 401 || res.status >= 500) {
    throw new AmbiguousWriteError(
      `${method} ${url}: HTTP ${res.status} — the server received this write and it MAY OR MAY NOT have landed. ` +
      `Do NOT resend; verify by hand. Body: ${JSON.stringify(text.slice(0, 200))}`,
      res.status,
    );
  }
  // Other 4xx: cleanly rejected before applying. Did not land.
  throw new WriteFailedError(res.status, `${method} ${url}: HTTP ${res.status} — rejected, write did not land. Body: ${JSON.stringify(text.slice(0, 200))}`, text.slice(0, 200));
}

export const STAGE = { STAGING_HOST, PROD_HOST, REFRESH_SKEW_MS };
