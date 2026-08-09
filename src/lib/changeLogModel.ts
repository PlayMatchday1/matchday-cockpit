// Change Log — the pure model (Phase 16). No "use client", no "server-only": shared
// by the server hook that WRITES entries, the route that reads them, the screen that
// renders them, and the tests. The log is a byproduct: the diff IS the request, and
// the save already classifies the outcome by a read-back. This file is those two
// facts, kept — plus the grouping into one-entry-per-save and the deny-key guard.
//
// FOUR STATES, worded so FAILED and NO ANSWER can never share a label:
//   landed      2xx AND a read-back confirmed the change is present
//   failed      the server rejected it (clean 4xx, or refused before the network) —
//               it DEFINITELY did not happen
//   notapplied  2xx but the read-back does NOT show it — accepted, did nothing
//   unknown     no answer (ambiguous / 5xx / network) — it MAY or may not have happened

import { DENY_WRITE_FIELDS } from "@/lib/denyWriteFields";

export type LogState = "landed" | "failed" | "notapplied" | "unknown";
export const STATE_LABEL: Record<LogState, string> = {
  landed: "LANDED", failed: "FAILED", notapplied: "NOT APPLIED", unknown: "NO ANSWER",
};

// A rejection (4xx / denied field / denied endpoint / production bolt) DEFINITELY did
// not happen → failed. Everything else that threw is ambiguous → unknown. Names are
// matched loosely so this stays decoupled from the exact error classes.
export function outcomeForThrow(errName: string): "failed" | "unknown" {
  return errName === "WriteFailedError" || errName === "DeniedFieldError" ||
    errName === "DeniedEndpointError" || errName === "ProductionWriteBoltedError"
    ? "failed" : "unknown";
}
// A 2xx is only LANDED once a read-back confirms it — otherwise it is NOT APPLIED.
export const outcomeForOk = (appliedReadback: boolean): "landed" | "notapplied" => (appliedReadback ? "landed" : "notapplied");

// FAILED and LANDED are settled facts and are NEVER unresolved. NO ANSWER and NOT
// APPLIED are open questions until a human closes them.
export const isOpenState = (s: LogState): boolean => s === "unknown" || s === "notapplied";

export type Change = { key: string; field: string; before: unknown; after: unknown };
const norm = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);

// The changes a write records: one per body key, with BEFORE taken from the server
// read and AFTER the value the user tried to set. before is EVIDENCE (a read), not the
// client's claim. For a landed write the server-after equals `after`; for failed /
// not-applied the server never moved, but the log still shows what was attempted.
export function changesFromBody(before: Record<string, unknown>, body: Record<string, unknown>, label: (k: string) => string): Change[] {
  return Object.keys(body).map((k) => ({ key: k, field: label(k), before: before[k] ?? null, after: body[k] }));
}
// Did the resource actually move on the keys we wrote? (server before vs server after)
export function appliedOnServer(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => JSON.stringify(norm(before[k])) !== JSON.stringify(norm(after[k])));
}

// ── deny-key guard — a log is a SECOND place a secret could leak ──────────────
export function bodyHasDenied(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => DENY_WRITE_FIELDS.has(k));
}
export function stripDenied(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!DENY_WRITE_FIELDS.has(k)) out[k] = body[k];
  return out;
}

// ── one entry per SAVE ───────────────────────────────────────────────────────
// The store holds one row per request (the shared write path logs each write). An
// ENTRY is the group of rows sharing a saveId: a single match PUT is one row → one
// entry with N field-changes; a roster save is N rows → one entry "2 of 4 landed".
export type LogRow = {
  id: string; saveId: string; at: string; actorName: string; actorEmail?: string | null;
  source: string; env: string; matchId: number | null; matchName: string | null;
  method: string; endpoint: string; body: Record<string, unknown>;
  outcome: LogState; serverSaid?: string | null; changes: Change[];
  resolved?: "yes" | "no" | null; resolvedBy?: string | null; resolvedAt?: string | null;
};
export type LogEntry = {
  saveId: string; at: string; actorName: string; source: string; env: string;
  matchId: number | null; matchName: string | null; method: string; endpoint: string;
  body: Record<string, unknown>; serverSaid?: string | null; changes: Change[];
  outcome: LogState; requests: number; landedN: number;
  resolved: "yes" | "no" | null; resolvedBy?: string | null; resolvedAt?: string | null;
};

// Entry outcome precedence: the state that most demands attention wins, so a save is
// never quietly marked landed when one of its requests got no answer.
const RANK: Record<LogState, number> = { unknown: 3, notapplied: 2, failed: 1, landed: 0 };
export function entryOutcome(rows: LogRow[]): LogState {
  return rows.reduce<LogState>((worst, r) => (RANK[r.outcome] > RANK[worst] ? r.outcome : worst), "landed");
}
export function groupBySave(rows: LogRow[]): LogEntry[] {
  const by = new Map<string, LogRow[]>();
  for (const r of rows) { const g = by.get(r.saveId) ?? []; g.push(r); by.set(r.saveId, g); }
  const entries: LogEntry[] = [];
  for (const g of by.values()) {
    const first = g[0];
    entries.push({
      saveId: first.saveId, at: first.at, actorName: first.actorName, source: first.source, env: first.env,
      matchId: first.matchId, matchName: first.matchName, method: first.method, endpoint: first.endpoint,
      body: first.body, serverSaid: g.find((r) => r.serverSaid)?.serverSaid ?? null,
      changes: g.flatMap((r) => r.changes),
      outcome: entryOutcome(g), requests: g.length, landedN: g.filter((r) => r.outcome === "landed").length,
      resolved: first.resolved ?? null, resolvedBy: first.resolvedBy ?? null, resolvedAt: first.resolvedAt ?? null,
    });
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
}
// An entry is unresolved only if its outcome is open AND no human has closed it.
export const entryUnresolved = (e: LogEntry): boolean => isOpenState(e.outcome) && !e.resolved;

// Filters COMBINE (person AND outcome AND source), never replace. "needs" = the
// unresolved (open-question) set.
export type LogFilters = { outcome: "all" | "needs" | LogState; who: string; source: string };
export function passesLogFilters(e: LogEntry, f: LogFilters): boolean {
  const byOut = f.outcome === "all" ? true : f.outcome === "needs" ? entryUnresolved(e) : e.outcome === f.outcome;
  return byOut && (f.who === "all" || e.actorName === f.who) && (f.source === "all" || e.source === f.source);
}
