// MatchDay platform API client. Server-only — never imported into
// the browser bundle (reads MATCHDAY_API_PASSWORD from process.env).
//
// Usage:
//   const client = getMatchdayApiClient();
//   const data = await client.get("/admin/players", { page: 1, limit: 100 });
//
// Auth model:
//   - First call signs in via POST /auth/signin (email + password from env).
//   - Token cached in module-level memory for the process lifetime.
//   - On any 401 response from a downstream call, the cached token is
//     invalidated and we sign in again, then retry the request once.
//   - No refresh-token flow — re-login is one extra HTTP round-trip,
//     simpler to maintain, self-recovering when credentials rotate.
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
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "MatchdayApiError";
    this.status = status;
    this.body = body;
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

// POST /auth/signin and pull the access token out of the response.
// Tolerant of common shape variations (camelCase, snake_case,
// data-envelope) so a small server-side rename doesn't break us
// silently.
async function signIn(): Promise<string> {
  const { email, password, baseUrl } = getCreds();
  const res = await fetch(buildUrl(baseUrl, "/auth/signin"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response — leave body as null. The status code in
      // the thrown error is what the caller acts on.
    }
    if (res.status === 401) {
      throw new MatchdayApiAuthError(
        "Sign-in failed: bad credentials. Update MATCHDAY_API_PASSWORD (or MATCHDAY_API_EMAIL) in Vercel env / .env.local.",
      );
    }
    throw new MatchdayApiError(
      res.status,
      `Sign-in failed (HTTP ${res.status})`,
      body,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
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

      const doFetch = async (token: string) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

      let token = await ensureToken();
      let res = await doFetch(token);

      // 401 → token expired or rotated mid-run. Invalidate and
      // re-sign-in once, then retry the same request.
      if (res.status === 401) {
        cachedToken = null;
        token = await ensureToken();
        res = await doFetch(token);
      }

      if (!res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          // ignore — non-JSON response body
        }
        throw new MatchdayApiError(
          res.status,
          `${path} failed (HTTP ${res.status})`,
          body,
        );
      }
      return (await res.json()) as T;
    },
  };
}

// Test-only — clear the cached token so a unit/integration test can
// force a fresh sign-in. Not exported via index; direct import only.
export function _resetCachedToken(): void {
  cachedToken = null;
}
