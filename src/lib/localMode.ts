// LOCAL MODE: the Clubhouse pointed at a MatchDay API running on this machine (the backend's
// feature/match-manager-track branch on http://localhost:3000, fake seed data). One flag, and it
// only works in `next dev`.
//
// WHY IT EXISTS. The Match Manager admin endpoints (admin/match-manager/*) exist only on the local
// backend. The Clubhouse has ONE Supabase project and it is production, so a local Clubhouse still
// reads and writes production Supabase. Pointing it at seed data without these guards would let a
// sync copy fake rows into production mdapi_* tables and put test writes in production change_log.
//
// WHAT THE FLAG DOES, everywhere at once (each guard has its own assertion in
// scripts/local-mode-guard-test.ts):
//   1. Write client (matchdayStageApi): allows the "local" environment, host EXACTLY localhost:3000
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

export const LOCAL_MDAPI_HOST = "localhost:3000";
export const LOCAL_MDAPI_BASE_URL = `http://${LOCAL_MDAPI_HOST}`;

type Env = Record<string, string | undefined>;

export function localModeOn(env: Env = process.env): boolean {
  return env.MATCHDAY_LOCAL_API === "1" && env.NODE_ENV === "development" && !env.VERCEL;
}

// Thrown wherever local mode refuses something that would reach production data.
export class LocalModeRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "LocalModeRefusedError"; }
}
