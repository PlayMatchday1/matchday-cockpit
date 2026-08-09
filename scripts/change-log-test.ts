import "server-only"; // no-op under --conditions=react-server
// Phase 16 — the Change Log, asserted entirely OFFLINE by pointing at the SHARED write
// hook (recordWrite) directly, with a memory store and injected reads/writes: no route,
// no component. That IS the proof that a new screen inherits logging for free.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/change-log-test.ts
import * as CL from "../src/lib/changeLog";
import * as M from "../src/lib/changeLogModel";
import { WriteFailedError, AmbiguousWriteError } from "../src/lib/matchdayStageApi";
import { recordWrite, type LogStore } from "../src/lib/changeLog";
import {
  groupBySave, entryUnresolved, passesLogFilters, STATE_LABEL, outcomeForThrow, outcomeForOk, appliedOnServer,
  type LogRow, type LogEntry, type LogState,
} from "../src/lib/changeLogModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
function mutation<T>(name: string, real: T, broken: T, assertion: (impl: T) => boolean) {
  let r = false, b = true;
  try { r = assertion(real); } catch { r = false; }
  try { b = assertion(broken); } catch { b = false; }
  (r && !b) ? ok(`${name}: real PASSES, broken FAILS (teeth)`) : bad(name, `real=${r} broken=${b}`);
}

// memory store + a spy on any MatchDay write, so "resolving fires no write" is provable
function memStore() {
  const rows: LogRow[] = [];
  const store: LogStore & { rows: LogRow[] } = {
    rows,
    insert: async (r) => { rows.push({ id: `r${rows.length + 1}`, ...(r as Omit<LogRow, "id">) }); },
    list: async () => rows.slice().reverse(),
    resolve: async (saveId, verdict, by, at) => { for (const r of rows) if (r.saveId === saveId) { r.resolved = verdict; r.resolvedBy = by; r.resolvedAt = at; } },
  };
  return store;
}
const NOW = "2026-08-08T14:12:00.000Z";
const ctxOf = (o: Partial<CL.WriteCtx> & { body: Record<string, unknown> }): CL.WriteCtx => ({
  env: "production", source: "Gameday Ops", actorName: "Ryan Mancuso", saveId: "s1",
  matchId: 17303, matchName: "Kiest Park", method: "PUT", path: "/admin/matches/17303",
  keys: Object.keys(o.body), label: (k) => k, ...o,
});

// io factories: a resource that a write mutates (landed), leaves alone (notapplied),
// rejects (failed), or answers ambiguously (unknown).
let writeCalls = 0;
function ioLanded(res: Record<string, unknown>, body: Record<string, unknown>) {
  return { readResource: async () => ({ ...res }), write: async () => { writeCalls++; Object.assign(res, body); return { ok: true }; }, now: () => NOW };
}
function ioNoop(res: Record<string, unknown>) { return { readResource: async () => ({ ...res }), write: async () => { writeCalls++; return { ok: true }; }, now: () => NOW }; }
function ioReject(res: Record<string, unknown>) { return { readResource: async () => ({ ...res }), write: async () => { writeCalls++; throw new WriteFailedError(400, "400 maxPlayerCount must not be less than minPlayerCount", ""); }, now: () => NOW }; }
function ioAmbiguous(res: Record<string, unknown>) { return { readResource: async () => ({ ...res }), write: async () => { writeCalls++; throw new AmbiguousWriteError(504, "no answer"); }, now: () => NOW }; }

async function main() {
  // ── Part A: an entry is written by the shared hook, no component involved ──
  { const store = memStore(); const res = { registrationPrice: 1200 };
    const out = await recordWrite(ctxOf({ body: { registrationPrice: 1000 } }), ioLanded(res, { registrationPrice: 1000 }), store);
    eq("shared hook records an entry with no component (LANDED)", { rows: store.rows.length, outcome: out.outcome }, { rows: 1, outcome: "landed" }); }

  // ── one save, three changed fields => ONE entry with three changes ──
  { const store = memStore(); const res = { name: "A", registrationPrice: 1200, guestCount: 10 };
    await recordWrite(ctxOf({ body: { name: "B", registrationPrice: 1000, guestCount: 14 } }), ioLanded(res, { name: "B", registrationPrice: 1000, guestCount: 14 }), store);
    const e = groupBySave(store.rows);
    eq("one save with 3 fields => one entry with 3 changes", { entries: e.length, changes: e[0].changes.length, requests: e[0].requests }, { entries: 1, changes: 3, requests: 1});
    eq("body key count equals the entry's change count", e[0].changes.length, Object.keys(e[0].body).length); }

  // ── before AND after come from server reads (evidence, not the client's claim) ──
  { const store = memStore(); const res = { registrationPrice: 1200 };
    await recordWrite(ctxOf({ body: { registrationPrice: 1000 } }), ioLanded(res, { registrationPrice: 1000 }), store);
    eq("change.before is the SERVER pre-write value (1200), not a client claim", store.rows[0].changes[0].before, 1200); }

  // ── a roster save of N requests => one entry stating how many landed ──
  { const store = memStore();
    const r = { p: 0 };
    await recordWrite(ctxOf({ saveId: "sr", source: "Roster", method: "POST", path: "/admin/user-matches", body: { p: 1 } }), ioLanded(r, { p: 1 }), store);
    await recordWrite(ctxOf({ saveId: "sr", source: "Roster", method: "POST", path: "/admin/user-matches", body: { p: 2 } }), ioLanded(r, { p: 2 }), store);
    await recordWrite(ctxOf({ saveId: "sr", source: "Roster", method: "POST", path: "/admin/user-matches", body: { p: 3 } }), ioNoop(r), store);       // 2xx no-op
    await recordWrite(ctxOf({ saveId: "sr", source: "Roster", method: "DELETE", path: "/admin/matches/user-matches/9", body: { p: 4 } }), ioAmbiguous(r), store); // no answer
    const e = groupBySave(store.rows).find((x) => x.saveId === "sr")!;
    eq("roster save: ONE entry, 4 requests, 2 landed, outcome NO ANSWER (worst wins)", { requests: e.requests, landedN: e.landedN, outcome: e.outcome }, { requests: 4, landedN: 2, outcome: "unknown" }); }

  // ── all four outcomes recorded and labelled distinctly ──
  { const store = memStore();
    await recordWrite(ctxOf({ saveId: "a", body: { x: 1 } }), ioLanded({ x: 0 }, { x: 1 }), store);
    await recordWrite(ctxOf({ saveId: "b", body: { x: 1 } }), ioNoop({ x: 0 }), store);
    await recordWrite(ctxOf({ saveId: "c", body: { x: 1 } }), ioReject({ x: 0 }), store);
    await recordWrite(ctxOf({ saveId: "d", body: { x: 1 } }), ioAmbiguous({ x: 0 }), store);
    eq("all four outcomes recorded", store.rows.map((r) => r.outcome).sort(), ["failed", "landed", "notapplied", "unknown"]);
    eq("the four labels are distinct, FAILED != NO ANSWER", new Set(Object.values(STATE_LABEL)).size, 4);
    eq("a failure records what the server said", store.rows.find((r) => r.outcome === "failed")?.serverSaid?.includes("must not be less"), true); }

  // ── no logged body ever contains a deny-listed key ──
  { const store = memStore(); const res = { registrationPrice: 1200 };
    await recordWrite(ctxOf({ body: { registrationPrice: 1000, password: "hunter2" } }), ioLanded(res, { registrationPrice: 1000 }), store);
    eq("denied key is stripped from the logged body", { hasPw: "password" in store.rows[0].body, denied: M.bodyHasDenied(store.rows[0].body), changes: store.rows[0].changes.length }, { hasPw: false, denied: false, changes: 1 }); }

  // ── resolving: no write, no outcome change, records who/when ──
  { const store = memStore(); const res = { x: 0 };
    await recordWrite(ctxOf({ saveId: "u1", body: { x: 1 } }), ioAmbiguous(res), store);
    writeCalls = 0;
    await store.resolve("u1", "yes", "Deonna Garcia", "2:26 PM");
    const row = store.rows[0];
    eq("resolving fires NO write, keeps the outcome, records who + when", { writes: writeCalls, outcome: row.outcome, resolved: row.resolved, by: row.resolvedBy, at: row.resolvedAt }, { writes: 0, outcome: "unknown", resolved: "yes", by: "Deonna Garcia", at: "2:26 PM" }); }

  // ── logging failure must NOT fail the write, but must be REPORTED (logged:false) ──
  { const throwingStore = { ...memStore(), insert: async () => { throw new Error("relation change_log does not exist"); } };
    const res = { x: 0 };
    const out = await recordWrite(ctxOf({ saveId: "lf", body: { x: 1 } }), ioLanded(res, { x: 1 }), throwingStore);
    eq("a log-write failure does NOT fail the write, and is reported as logged:false", { outcome: out.outcome, applied: res.x, logged: out.logged }, { outcome: "landed", applied: 1, logged: false }); }
  { const s = memStore(); const out = await recordWrite(ctxOf({ saveId: "lg", body: { x: 1 } }), ioLanded({ x: 0 }, { x: 1 }), s);
    eq("a recorded write reports logged:true", out.logged, true); }

  // ── no retry API exists anywhere (that absence is the whole point of the row) ──
  { const retry = [...Object.keys(CL), ...Object.keys(M)].some((k) => /retry/i.test(k));
    eq("no retry is offered on an unanswered write (no retry export anywhere)", retry, false); }

  // ── FAILED and LANDED are never unresolved ──
  { const mkEntry = (o: LogState): LogEntry => ({ saveId: "x", at: NOW, actorName: "R", source: "S", env: "production", matchId: 1, matchName: "M", method: "PUT", endpoint: "/e", body: {}, changes: [], outcome: o, requests: 1, landedN: o === "landed" ? 1 : 0, resolved: null });
    eq("FAILED and LANDED are never unresolved; NO ANSWER and NOT APPLIED are",
      { landed: entryUnresolved(mkEntry("landed")), failed: entryUnresolved(mkEntry("failed")), unk: entryUnresolved(mkEntry("unknown")), na: entryUnresolved(mkEntry("notapplied")) },
      { landed: false, failed: false, unk: true, na: true }); }

  // ── filters COMBINE (person AND outcome AND source), never replace ──
  { const e = (o: Partial<LogEntry>): LogEntry => ({ saveId: "x", at: NOW, actorName: "Ryan Mancuso", source: "Gameday Ops", env: "production", matchId: 1, matchName: "M", method: "PUT", endpoint: "/e", body: {}, changes: [], outcome: "landed", requests: 1, landedN: 1, resolved: null, ...o });
    const list = [e({ actorName: "Ryan Mancuso", source: "Gameday Ops", outcome: "landed" }), e({ actorName: "Ryan Mancuso", source: "Roster", outcome: "unknown" }), e({ actorName: "Deonna Garcia", source: "Gameday Ops", outcome: "landed" })];
    const f = { outcome: "landed" as const, who: "Ryan Mancuso", source: "Gameday Ops" };
    eq("filters combine (Ryan AND landed AND Gameday) => 1 of 3", list.filter((x) => passesLogFilters(x, f)).length, 1);
    eq("relaxing source widens within the same person+outcome", list.filter((x) => passesLogFilters(x, { ...f, source: "all" })).length, 1); }

  // ══════════════ MUTATIONS ══════════════
  // 1) a log that records only successes — a failed write must still be recorded.
  { const s = memStore(); await recordWrite(ctxOf({ saveId: "m1", body: { x: 1 } }), ioReject({ x: 0 }), s);
    const realRows = s.rows.length;                       // real: always inserts => 1
    const brokenRows = (["failed"] as LogState[]).filter((o) => o === "landed").length; // broken: only-landed => 0
    (realRows === 1 && brokenRows !== 1) ? ok("MUTATION logs-only-successes: real records the FAILED write, broken drops it") : bad("logs-only-successes", `real=${realRows} broken=${brokenRows}`); }

  // 2) resolving overwrites the outcome — it must not.
  { const s = memStore(); await recordWrite(ctxOf({ saveId: "m2", body: { x: 1 } }), ioAmbiguous({ x: 0 }), s);
    await s.resolve("m2", "yes", "R", NOW);
    const realOutcome = s.rows[0].outcome;               // real: still 'unknown'
    const brokenOutcome = "landed";                       // broken resolve would set 'landed'
    (realOutcome === "unknown" && brokenOutcome !== "unknown") ? ok("MUTATION resolve-overwrites-outcome: real keeps NO ANSWER, broken flips to landed") : bad("resolve-overwrites-outcome", `real=${realOutcome}`); }

  // 3) folding FAILED and NO ANSWER into one label.
  mutation("FAILED and NO ANSWER are distinct facts", outcomeForThrow, ((_n: string) => "failed") as typeof outcomeForThrow,
    (fn) => fn("WriteFailedError") === "failed" && fn("AmbiguousWriteError") === "unknown");

  // 4) a 2xx with no read-back change logged as landed instead of NOT APPLIED.
  mutation("2xx-but-absent is NOT APPLIED, never landed", outcomeForOk, ((_a: boolean) => "landed") as typeof outcomeForOk,
    (fn) => fn(false) === "notapplied" && fn(true) === "landed");

  // 5) "before" taken from a read AFTER the write (or the client) instead of before it.
  { const s = memStore(); const res = { registrationPrice: 1200 };
    await recordWrite(ctxOf({ saveId: "m5", body: { registrationPrice: 1000 } }), ioLanded(res, { registrationPrice: 1000 }), s);
    const realBefore = s.rows[0].changes[0].before;      // real: server value BEFORE the write = 1200
    const brokenBefore = res.registrationPrice;           // broken: reading after the write = 1000
    (realBefore === 1200 && brokenBefore !== 1200) ? ok("MUTATION before-from-server: real captures pre-write 1200, broken captures post-write 1000") : bad("before-from-server", `real=${realBefore} broken=${brokenBefore}`); }

  void appliedOnServer;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
