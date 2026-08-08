import "server-only"; // no-op under --conditions=react-server
// Change Log — the SHARED write hook (Phase 16). This is where logging lives: any
// write path that goes through recordWrite() is logged, so a fifth screen inherits
// the log without anyone remembering to add it. The routes call recordWrite instead
// of apiWrite directly; a test can point straight at recordWrite with no component
// involved and confirm an entry is recorded.
//
// THREE ROUND TRIPS, on purpose: read the resource BEFORE the write and AFTER it, and
// take both sides of every change from those reads. The client's "before" is a claim;
// a read is evidence. The extra read is the price of a log you can trust.
//
// Storage: a Supabase table `change_log` (migration 0113). Reads are NEVER logged —
// only writes. Denied keys are stripped before storage (a log is a second place a
// secret could leak). Retention: see docs/matchday-api-facts.md — currently indefinite
// (no auto-prune yet); a prune job over created_at is the intended next step.

import { makeServerClient } from "@/lib/supabaseServer";
import {
  changesFromBody, appliedOnServer, outcomeForOk, outcomeForThrow, stripDenied, bodyHasDenied,
  type LogState, type LogRow, type Change,
} from "@/lib/changeLogModel";

export type LogStore = {
  insert: (row: Omit<LogRow, "id"> & { id?: string }) => Promise<void>;
  list: (limit?: number) => Promise<LogRow[]>;
  resolve: (saveId: string, verdict: "yes" | "no", by: string, at: string) => Promise<void>;
};

// Default store: the Supabase table, written with the service-role client.
export function supabaseLogStore(): LogStore {
  const sb = makeServerClient();
  return {
    async insert(row) {
      await sb.from("change_log").insert({
        save_id: row.saveId, actor_name: row.actorName, actor_email: row.actorEmail ?? null,
        source: row.source, env: row.env, match_id: row.matchId, match_name: row.matchName,
        method: row.method, endpoint: row.endpoint, request_body: row.body, outcome: row.outcome,
        server_said: row.serverSaid ?? null, changes: row.changes,
      });
    },
    async list(limit = 500) {
      const { data } = await sb.from("change_log").select("*").order("created_at", { ascending: false }).limit(limit);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        id: String(r.id), saveId: r.save_id as string, at: r.created_at as string,
        actorName: (r.actor_name as string) ?? "", actorEmail: (r.actor_email as string) ?? null,
        source: r.source as string, env: r.env as string, matchId: (r.match_id as number) ?? null,
        matchName: (r.match_name as string) ?? null, method: r.method as string, endpoint: r.endpoint as string,
        body: (r.request_body as Record<string, unknown>) ?? {}, outcome: r.outcome as LogState,
        serverSaid: (r.server_said as string) ?? null, changes: (r.changes as Change[]) ?? [],
        resolved: (r.resolved as "yes" | "no") ?? null, resolvedBy: (r.resolved_by as string) ?? null, resolvedAt: (r.resolved_at as string) ?? null,
      }));
    },
    // Resolving records what a human found. It fires NO write to MatchDay and does NOT
    // touch `outcome` — only the resolution columns.
    async resolve(saveId, verdict, by, at) {
      await sb.from("change_log").update({ resolved: verdict, resolved_by: by, resolved_at: at }).eq("save_id", saveId);
    },
  };
}

export type WriteCtx = {
  env: string; source: string; actorName: string; actorEmail?: string | null; saveId: string;
  matchId: number | null; matchName?: string | null; method: string; path: string;
  body: Record<string, unknown>; keys: string[]; label: (k: string) => string;
};
export type WriteIO = {
  readResource: () => Promise<Record<string, unknown>>; // before AND after come from this
  write: () => Promise<unknown>;                          // the guarded apiWrite, injected
  now: () => string;                                      // injected so tests are deterministic
};

// THE shared hook. Reads before, writes, reads after, classifies, records — and
// returns the outcome so the caller can respond. Logging never throws over the write:
// a failed write is a real result to record, not an error to hide.
export async function recordWrite(ctx: WriteCtx, io: WriteIO, store: LogStore): Promise<{ outcome: LogState; result?: unknown; error?: Error }> {
  const before = await io.readResource().catch(() => ({} as Record<string, unknown>));
  let outcome: LogState; let serverSaid: string | null = null; let result: unknown; let error: Error | undefined;
  let after = before;
  try {
    result = await io.write();
    after = await io.readResource().catch(() => before);
    outcome = outcomeForOk(appliedOnServer(before, after, ctx.keys));
  } catch (e) {
    error = e as Error;
    outcome = outcomeForThrow((e as Error).name);
    serverSaid = (e as Error).message ?? String(e);
    after = before; // a throw means the read-after is meaningless; the before stands
  }
  // BEFORE from the server read; AFTER is what was attempted (the body). Strip denied
  // keys and refuse to store a body that still carries one.
  const safeBody = stripDenied(ctx.body);
  if (bodyHasDenied(safeBody)) throw new Error("refusing to log a denied key");
  const changes = changesFromBody(before, safeBody, ctx.label);
  await store.insert({
    saveId: ctx.saveId, at: io.now(), actorName: ctx.actorName, actorEmail: ctx.actorEmail ?? null,
    source: ctx.source, env: ctx.env, matchId: ctx.matchId, matchName: ctx.matchName ?? null,
    method: ctx.method, endpoint: ctx.path, body: safeBody, outcome, serverSaid, changes,
  });
  return { outcome, result, error };
}
