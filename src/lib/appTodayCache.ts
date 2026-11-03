// STAFF APP GAMEDAY CACHE (Ryan, 2026-11-02). The Today answer is cached 15 seconds per city scope
// and day in the Next.js data cache (shared by every server instance), tagged per environment. Any
// staff app write that changes a match (Adjust, roster and size, cancel, details, manager) expires
// the tag, so the next Today read for every day and scope is live. Clearing every day rather than
// the match's own is deliberate: it cannot miss a match that sits on the other side of midnight,
// and writes are rare next to reads.

import { revalidateTag } from "next/cache";

export const TODAY_TTL_S = 15;
/** An answer older than this is read again before it is served, however the cache aged it. */
export const TODAY_MAX_AGE_MS = 20_000;
export const todayTag = (env: string) => `app-today:${env}`;
export const todayScopeTag = (env: string, date: string, scope: string) => `app-today:${env}:${date}:${scope}`;

/** After a write that changed a match: the next Today read is live, for every day and scope. */
export function clearToday(env: string): void {
  try { revalidateTag(todayTag(env), { expire: 0 }); } catch (e) { console.error(`[app-today] cache clear failed: ${e instanceof Error ? e.message : String(e)}`); }
}
