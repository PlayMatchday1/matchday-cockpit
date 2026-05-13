// MatchDay platform API client. Server-only — never imported into
// the browser bundle (reads MATCHDAY_API_PASSWORD from process.env).
//
// Usage:
//   const client = getMatchdayApiClient();
//   const data = await client.get("/admin/players", { page: 1, limit: 100 });
//
// === Hardened fetch layer (fetchMatchDayJson) ===
//
// Every call to the upstream MatchDay API goes through
// fetchMatchDayJson. The upstream platform occasionally serves HTML
// error pages or plain-text messages on 5xx, and the unconditional
// JSON.parse that used to live here would throw an opaque
// "Unexpected token 'A', \"An error o\"..." with no diagnostic value
// — that's the failure mode this rewrite eliminates.
//
//   - Body is read via res.text() first, never res.json() directly.
//   - Content-Type is verified to include "application/json" before
//     parsing. A 200 with text/html is treated as a hard error so the
//     sync job fails LOUD (with the body snippet) instead of
//     corrupting downstream state.
//   - A 200-character body snippet is included in every thrown error
//     so the actual upstream response is visible in Vercel logs.
//   - Transient failures (502 / 503 / 504 / 429 / network errors /
//     JSON parse failures) are retried up to 3 times with 1s/2s/4s
//     exponential backoff. 429 honors the Retry-After header when
//     present (delta-seconds or HTTP-date), capped at 30s.
//   - 401 triggers the optional refreshAuth hook (used by client.get
//     to wipe cachedToken and re-sign-in) and one retry. Subsequent
//     401s throw MatchdayApiAuthError.
//
// Auth model is unchanged:
//   - First call signs in via POST /auth/signin (email + password from env).
//   - Token cached in module-level memory for the process lifetime.
//   - On any 401 response from a downstream call, the cached token is
//     invalidated and we sign in again, then retry the request once.
//
// Credentials are read from process.env at call time (not module
// init) so a build that doesn't actually call this module won't fail
// just because the env vars aren't set.

const DEFAULT_BASE_URL = "https://playmatchday.herokuapp.com";

export class MatchdayApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchdayApiAuthError";
  }
}

export class MatchdayApiError extends Error {
  status: number;
  body: unknown;
  url: string;
  bodySnippet: string;
  constructor(
    status: number,
    message: string,
    body: unknown,
    url: string,
    bodySnippet: string,
  ) {
    super(message);
    this.name = "MatchdayApiError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

// Module-level cache. Lives for the duration of the process — fine
// for short-lived script runs and for serverless function invocations
// (where the module is re-loaded per cold start anyway).
let cachedToken: string | null = null;

type Creds = { email: string; password: string; baseUrl: string };

function getCreds(): Creds {
  const email = process.env.MATCHDAY_API_EMAIL;
  const password = process.env.MATCHDAY_API_PASSWORD;
  const baseUrl = process.env.MATCHDAY_API_BASE_URL ?? DEFAULT_BASE_URL;
  if (!email) {
    throw new MatchdayApiAuthError(
      "Missing MATCHDAY_API_EMAIL — set in Vercel env (Production) or .env.local for local runs",
    );
  }
  if (!password) {
    throw new MatchdayApiAuthError(
      "Missing MATCHDAY_API_PASSWORD — set in Vercel env (Production) or .env.local for local runs",
    );
  }
  return { email, password, baseUrl };
}

// Build a URL by joining base + path + query. Path should start with
// a "/"; trailing slash on baseUrl is fine.
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number>,
): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse Retry-After per RFC 7231: either delta-seconds (integer) or
// an HTTP-date. Returns ms to wait, or null if unparseable. Capped at
// 30s so a misbehaving upstream can't pin us forever.
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 30_000);
  }
  const dt = Date.parse(trimmed);
  if (!Number.isNaN(dt)) {
    const delta = dt - Date.now();
    if (delta > 0) return Math.min(delta, 30_000);
  }
  return null;
}

// Truncate a response body to 200 chars for inclusion in error
// messages so upstream HTML / plain-text responses are visible in
// logs without flooding them.
function snippet(text: string): string {
  if (text.length <= 200) return text;
  return text.slice(0, 200) + "…";
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
// Index aligns with the retry attempt that's about to run: BACKOFF_MS[0]
// fires before attempt 1, BACKOFF_MS[1] before attempt 2, etc.
const BACKOFF_MS = [1000, 2000, 4000];

type FetchOpts = {
  // Hook called on 401 BEFORE the one-shot auth retry. Implementations
  // typically wipe a cached token and re-authenticate, then return the
  // new headers to merge into init for the retry. Returning null
  // signals "auth refresh not available" and we throw immediately.
  refreshAuth?: () => Promise<HeadersInit | null>;
};

// The single transport for every MatchDay-API call. Public so test
// code + direct script callers can use it; the canonical entry point
// is still client.get().
export async function fetchMatchDayJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: FetchOpts = {},
): Promise<T> {
  let didRefreshAuth = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      await sleep(backoff);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // Network-level failure (DNS, ECONNRESET, fetch timeout). Retry.
      if (attempt < MAX_RETRIES) continue;
      const msg = e instanceof Error ? e.message : String(e);
      throw new MatchdayApiError(
        0,
        `${url}: network error after ${attempt + 1} attempts: ${msg}`,
        null,
        url,
        "",
      );
    }

    // 401: invoke refreshAuth (one-shot, doesn't count toward the
    // retry budget — rewind `attempt` so a real transient 5xx after
    // the refresh still gets its full retry quota).
    if (res.status === 401 && opts.refreshAuth && !didRefreshAuth) {
      didRefreshAuth = true;
      const newHeaders = await opts.refreshAuth();
      if (newHeaders) {
        init = {
          ...init,
          headers: { ...(init.headers ?? {}), ...newHeaders },
        };
        attempt--;
        continue;
      }
      // refreshAuth returned null → no recovery path; fall through to
      // the body-read + throw below.
    }

    // Read body as text once. Subsequent decisions are made from this
    // string — we never call res.json() directly because the upstream
    // sometimes serves HTML/plain-text on 5xx.
    const bodyText = await res.text();
    const bodySnippet = snippet(bodyText);

    // 401 that survived the refresh attempt (or had no hook) is terminal.
    if (res.status === 401) {
      throw new MatchdayApiAuthError(
        `${url}: HTTP 401 (${didRefreshAuth ? "auth refresh did not recover" : "no auth refresh available"}). Body: ${JSON.stringify(bodySnippet)}`,
      );
    }

    if (RETRYABLE_STATUS.has(res.status)) {
      if (attempt < MAX_RETRIES) {
        // Respect Retry-After on 429 — sleep the suggested duration
        // INSTEAD of (or in addition to, whichever is longer) the
        // loop's next exponential backoff.
        if (res.status === 429) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          if (retryAfter !== null && retryAfter > 0) {
            await sleep(retryAfter);
          }
        }
        continue;
      }
      throw new MatchdayApiError(
        res.status,
        `${url}: HTTP ${res.status} after ${attempt + 1} attempts. Body: ${JSON.stringify(bodySnippet)}`,
        null,
        url,
        bodySnippet,
      );
    }

    // Other non-OK statuses (4xx or unmapped 5xx) are terminal.
    if (!res.ok) {
      throw new MatchdayApiError(
        res.status,
        `${url}: HTTP ${res.status}. Body: ${JSON.stringify(bodySnippet)}`,
        null,
        url,
        bodySnippet,
      );
    }

    // 200 OK but wrong content type — treat as a hard error so
    // downstream JSON.parse can't surface a confusing
    // "Unexpected token 'A'..." message. The body snippet in the
    // thrown error tells us exactly what the upstream returned.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new MatchdayApiError(
        res.status,
        `${url}: expected application/json, got ${JSON.stringify(contentType || "<empty>")}. Body: ${JSON.stringify(bodySnippet)}`,
        null,
        url,
        bodySnippet,
      );
    }

    try {
      return JSON.parse(bodyText) as T;
    } catch (e) {
      // Parse failures can happen on truncated/streaming responses
      // during upstream restarts — retry along with the transient
      // status codes.
      if (attempt < MAX_RETRIES) continue;
      const msg = e instanceof Error ? e.message : String(e);
      throw new MatchdayApiError(
        res.status,
        `${url}: JSON parse failed after ${attempt + 1} attempts (${msg}). Body: ${JSON.stringify(bodySnippet)}`,
        null,
        url,
        bodySnippet,
      );
    }
  }

  // Unreachable — the loop above either returns or throws on every
  // path. TypeScript's flow analysis can't see that, so satisfy it
  // explicitly.
  throw new MatchdayApiError(
    0,
    `${url}: retry loop exited without resolving`,
    null,
    url,
    "",
  );
}

// POST /auth/signin and pull the access token out of the response.
// Tolerant of common shape variations (camelCase, snake_case,
// data-envelope) so a small server-side rename doesn't break us
// silently.
async function signIn(): Promise<string> {
  const { email, password, baseUrl } = getCreds();
  const url = buildUrl(baseUrl, "/auth/signin");
  let json: Record<string, unknown>;
  try {
    json = await fetchMatchDayJson<Record<string, unknown>>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    if (e instanceof MatchdayApiError && e.status === 401) {
      throw new MatchdayApiAuthError(
        "Sign-in failed: bad credentials. Update MATCHDAY_API_PASSWORD (or MATCHDAY_API_EMAIL) in Vercel env / .env.local.",
      );
    }
    throw e;
  }
  const token =
    pickString(json, "accessToken") ??
    pickString(json, "access_token") ??
    pickString(json["data"], "accessToken") ??
    pickString(json["data"], "access_token");
  if (!token) {
    throw new MatchdayApiAuthError(
      "Sign-in returned no accessToken — response shape may have changed. Top-level keys: " +
        Object.keys(json).join(", "),
    );
  }
  return token;
}

function pickString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

async function ensureToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = await signIn();
  return cachedToken;
}

export interface MatchdayApiClient {
  get<T = unknown>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<T>;
}

export function getMatchdayApiClient(): MatchdayApiClient {
  // Validate env up front so callers get the missing-env error
  // immediately instead of on the first request.
  const { baseUrl } = getCreds();

  return {
    async get<T>(
      path: string,
      query?: Record<string, string | number>,
    ): Promise<T> {
      const url = buildUrl(baseUrl, path, query);
      const token = await ensureToken();
      return fetchMatchDayJson<T>(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        {
          refreshAuth: async () => {
            // Token expired or rotated mid-run — invalidate and
            // re-sign-in. The returned headers replace the bearer
            // for the one-shot retry inside fetchMatchDayJson.
            cachedToken = null;
            const fresh = await ensureToken();
            return { Authorization: `Bearer ${fresh}` };
          },
        },
      );
    },
  };
}

// Test-only — clear the cached token so a unit/integration test can
// force a fresh sign-in. Not exported via index; direct import only.
export function _resetCachedToken(): void {
  cachedToken = null;
}
