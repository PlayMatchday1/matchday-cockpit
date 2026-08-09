"use client";
// Log-health counter (Phase 16, follow-up). When a production write LANDS but the
// Change Log could not record it (logRecorded:false — e.g. the change_log table is
// unavailable, which is precisely when 0113 is unapplied), that is a HOLE, not a
// question. This counter makes the hole loud.
//
// Storage: localStorage, on purpose. It must survive a page reload AND not depend on
// the change_log table (the table being unavailable is the main reason it fires), so it
// cannot live in that table — and it must work RIGHT NOW with no migration. The trade-off
// is that it is per-browser (it counts the writes THIS operator made that went
// unrecorded), which is exactly who needs to see the banner while editing.

const KEY = "matchday-changelog-failures";
export type LogHealth = { count: number; lastAt: string | null };
const EMPTY: LogHealth = { count: 0, lastAt: null };
export const LOG_HEALTH_EVENT = "matchday-log-health";

export function getLogHealth(): LogHealth {
  if (typeof window === "undefined") return EMPTY;
  try { const raw = window.localStorage.getItem(KEY); if (!raw) return EMPTY; const v = JSON.parse(raw); return { count: Number(v.count) || 0, lastAt: v.lastAt ?? null }; }
  catch { return EMPTY; }
}
export function recordLogFailure(at: string = new Date().toISOString()): void {
  if (typeof window === "undefined") return;
  const cur = getLogHealth();
  const next: LogHealth = { count: cur.count + 1, lastAt: at };
  window.localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(LOG_HEALTH_EVENT, { detail: next }));
}
export function clearLogHealth(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(LOG_HEALTH_EVENT, { detail: EMPTY }));
}
// Call after any write response: if the server recorded the write but could not LOG it,
// bump the counter. logRecorded === false is the signal; undefined (older routes) is ignored.
export function noteLogResponse(json: unknown): void {
  if (json && typeof json === "object" && (json as { logRecorded?: boolean }).logRecorded === false) recordLogFailure();
}
