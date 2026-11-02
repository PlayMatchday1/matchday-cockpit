// LOCAL MODE: the Clubhouse pointed at a MatchDay API running on this machine (the backend's
// backend on http://localhost:3070 by default, or the host MATCHDAY_LOCAL_API_HOST names; fake seed data). One flag, and it
// only works in `next dev`.
//
// WHY IT EXISTS. The Match Manager admin endpoints (admin/match-manager/*) exist only on the local
// backend. The Clubhouse has ONE Supabase project and it is production, so a local Clubhouse still
// reads and writes production Supabase. Pointing it at seed data without these guards would let a
// sync copy fake rows into production mdapi_* tables and put test writes in production change_log.
//
// WHAT THE FLAG DOES, everywhere at once (each guard has its own assertion in
// scripts/local-mode-guard-test.ts):
//   1. Write client (matchdayStageApi): allows the "local" environment, host EXACTLY LOCAL_MDAPI_HOST
//      on the parsed URL, and REFUSES staging and production. Their hosts are unchanged.
//   2. Read client (matchdayApi): refuses every call before any fetch. Every mdapi sync reads
//      through it, so a sync has nothing to write.
//   3. proxy.ts: /api/sync/* answers 503 without running the route.
//   4. change_log: recordWrite and the Supabase log store write nothing.
//
// WHEN IT IS ON. All three must hold: MATCHDAY_LOCAL_API is exactly "1", NODE_ENV is exactly
// "development" (only `next dev` sets that; `next build`/`next start` and Vercel set "production"),
// and VERCEL is unset. Anything else is off, and off is byte-for-byte the behaviour on main.
//
// No "server-only" import: proxy.ts reads it too. It holds no secret.

// WHICH LOCAL BACKEND. A dev setting, not a constant per branch: Offers' combined backend runs on 3070, Match Manager's
// on 3000, the old field-covers one on 3010. MATCHDAY_LOCAL_API_HOST picks one, and only "localhost:<port>" is taken;
// anything else (another host, a scheme, a path) falls back to the default, so the setting cannot point the write
// client's local host guard anywhere but this machine. Read once at load, like the flag.
export const DEFAULT_LOCAL_MDAPI_HOST = "localhost:3070";
export function localHostFrom(env: Record<string, string | undefined>): string {
  const h = env.MATCHDAY_LOCAL_API_HOST?.trim();
  return h && /^localhost:\d{2,5}$/.test(h) ? h : DEFAULT_LOCAL_MDAPI_HOST;
}
export const LOCAL_MDAPI_HOST = localHostFrom(process.env);
export const LOCAL_MDAPI_BASE_URL = `http://${LOCAL_MDAPI_HOST}`;

type Env = Record<string, string | undefined>;

export function localModeOn(env: Env = process.env): boolean {
  return env.MATCHDAY_LOCAL_API === "1" && env.NODE_ENV === "development" && !env.VERCEL;
}

// Thrown wherever local mode refuses something that would reach production data.
export class LocalModeRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "LocalModeRefusedError"; }
}

// THE ENVIRONMENT IN A /api/matchday/{env}/ PATH. "staging" and "production" keep their meaning (and while local
// mode is on the write client refuses both). "local" exists ONLY while local mode is on; off, it is an unknown
// environment exactly as before. Used by the six routes the Gameday Ops board and match panel call.
export type PathEnv = "staging" | "production" | "local";
export function pathEnv(x: string, env: Env = process.env): PathEnv | null {
  if (x === "staging" || x === "production") return x;
  return x === "local" && localModeOn(env) ? "local" : null;
}
// A confined (city) account never uses local mode: the seed's cities are not real cities.
export const LOCAL_CONFINED_REFUSAL = "Local mode is for unconfined Match Ops accounts only.";

// ROUTES THAT MUST NOT RUN IN LOCAL MODE because they key PRODUCTION data by a match or field id, and the local seed's
// ids collide with real ones: a chat "notify" for seed match 104 would text real players of production match 104; a
// venue write for seed field 1 would edit production field 1's finance row. The first statement of each such handler.
// Off, null, and the handler runs exactly as before.
export function localModeRefusal(what: string, env: Env = process.env): Response | null {
  if (!localModeOn(env)) return null;
  return Response.json(
    { error: `${what} is off in local mode: it is keyed by match or field ids, and the local seed's ids collide with real ones. Nothing was read or sent.`, localMode: true },
    { status: 503 },
  );
}
