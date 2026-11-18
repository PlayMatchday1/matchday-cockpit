import "server-only"; // no-op under --conditions=react-server
// THE MATCHDAY GATE (src/lib/mdapiGate.ts), asserted on what it DOES — runtime, offline. A fake slot
// store shared by every call stands in for Supabase (it is what makes the bulk cap global: one table
// for every Vercel instance), and a fake fetch counts what would have reached the API. Staff and
// writes use the instance's own cap (the hybrid, Ryan 2026-11-18), asserted to make no store call.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/mdapi-gate-test.ts

import {
  mdapiFetch, withMdapiLane, currentLane, envOfUrl, labelOf, LANE_SIZE, LOCAL_CAP, BREAKER_STEPS_S, GLOBAL_LANES, __setGateDepsForTest,
  MdapiGateClosedError, MdapiGateBusyError, MdapiTimeoutError, type SlotStore, type MdapiLane,
} from "../src/lib/mdapiGate";
import { fetchMatchDayJson, getPacedClient } from "../src/lib/matchdayApi";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const rejects = async (n: string, Cls: new (...a: never[]) => Error, f: () => Promise<unknown>) => {
  try { await f(); bad(n, "did not throw"); } catch (e) { e instanceof Cls ? ok(n) : bad(n, `threw ${(e as Error).name}: ${(e as Error).message.slice(0, 90)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROD = "https://playmatchday.herokuapp.com";
const STAGE = "https://matchday-stage.herokuapp.com";

/** One shared table of slots, like 0275's: the SAME object for every "instance". */
function fakeStore(opts: { open?: Partial<Record<MdapiLane, string>>; down?: boolean; failures?: number } = {}) {
  const held: Record<MdapiLane, Set<number>> = { write: new Set(), staff: new Set(), bulk: new Set() };
  const reports: { lane: string; ok: boolean }[] = [];
  let acquires = 0;
  const store: SlotStore = {
    async acquire(_env, lane) {
      acquires++;
      if (opts.down) throw new Error("connection refused");
      if (lane !== "write" && opts.open?.[lane]) return { slot: null, openUntil: opts.open[lane]!, failures: 3 };
      for (let s = 1; s <= LANE_SIZE[lane]; s++) if (!held[lane].has(s)) { held[lane].add(s); return { slot: s, openUntil: null, failures: opts.failures ?? 0 }; }
      return { slot: null, openUntil: null, failures: 0 };
    },
    async release(lane, slot) { held[lane].delete(slot); },
    async report(_env, lane, okd) { reports.push({ lane, ok: okd }); },
  };
  return { store, held, reports, acquires: () => acquires };
}

/** A fetch that takes `ms` and records how many requests were in flight at once. */
function fakeFetch(ms: number, status = 200, body = '{"data":[]}') {
  let inFlight = 0, peak = 0;
  const urls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })); });
      });
    } finally { inFlight--; }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, peak: () => peak, urls };
}

const quiet = () => undefined;
const T = { write: 2000, staff: 300, bulk: 2000 };

async function main() {
  console.log("\nSTAFF: this instance's cap, no network call (Ryan's hybrid, 2026-11-18):");
  eq("only bulk takes a global slot", [...GLOBAL_LANES], ["bulk"]);
  {
    const s = fakeStore(); const ff = fakeFetch(40);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const logs: string[] = [];
    __setGateDepsForTest({ store: s.store, fetch: ff.f, log: (l) => logs.push(l), timeouts: T });
    await Promise.all(Array.from({ length: 40 }, (_, i) => mdapiFetch(`${PROD}/admin/matches/${i}`)));
    eq("40 parallel staff reads: never more than 16 in flight in one instance", ff.peak() <= LOCAL_CAP.staff, true);
    eq("...and the cap is reached, so the 16 is the gate and not a slow test (positive control)", ff.peak(), LOCAL_CAP.staff);
    eq("...every one of the 40 was sent, none dropped", ff.urls.length, 40);
    eq("...and every wait was logged", logs.filter((l) => l.includes("waited")).length, 40 - LOCAL_CAP.staff);
    restore();
  }
  {
    // The widest fan-out any screen makes today never waits: zero added latency.
    const s = fakeStore(); const ff = fakeFetch(40); const logs: string[] = [];
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: (l) => logs.push(l), timeouts: T });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: LOCAL_CAP.staff }, (_, i) => mdapiFetch(`${PROD}/admin/matches/${i}`)));
    eq("16 parallel staff reads: all at once, no wait", [ff.peak(), logs.length], [LOCAL_CAP.staff, 0]);
    eq("...one round of 40 ms, not two", Date.now() - t0 < 75, true);
    restore();
  }
  {
    // A queued read starts the moment a slot frees (a queue, not a poll).
    const s = fakeStore(); const ff = fakeFetch(50);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: LOCAL_CAP.staff + 1 }, (_, i) => mdapiFetch(`${PROD}/admin/matches/${i}`)));
    const ms = Date.now() - t0;
    eq("17 reads of 50 ms: the 17th starts as the first ends (~100 ms, no polling gap)", ms >= 95 && ms < 140, true);
    eq("...and not one asked the slot store (zero added latency)", s.acquires(), 0);
    restore();
  }
  {
    const s = fakeStore(); const ff = fakeFetch(30);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await Promise.all(Array.from({ length: 8 }, (_, i) => withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/players?page=${i}`))));
    eq("8 parallel bulk reads: one at a time", ff.peak(), 1);
    eq("...all 8 sent", ff.urls.length, 8);
    // A request waiting for the one bulk slot asks again until it frees, so asks >= requests.
    eq("...each through the GLOBAL slot store (positive control for the zero above)", s.acquires() >= 8, true);
    eq("...and the one bulk slot was given back", s.held.bulk.size, 0);
    restore();
  }
  {
    // A night pass holding bulk cannot take a staff screen's room.
    const s = fakeStore(); const ff = fakeFetch(60);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const bulk = withMdapiLane("bulk", () => Promise.all(Array.from({ length: 4 }, (_, i) => mdapiFetch(`${PROD}/admin/matches/reviews?page=${i}`))));
    await sleep(5);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, (_, i) => mdapiFetch(`${PROD}/admin/matches/${100 + i}`)));
    const staffMs = Date.now() - t0;
    eq("with bulk busy, 6 staff reads still run together (one round, not queued behind bulk)", staffMs < 150, true);
    await bulk;
    restore();
  }

  console.log("\nTHE BREAKER — reads stop, writes never:");
  {
    const s = fakeStore({ open: { staff: "2026-11-18T20:00:00Z", bulk: "2026-11-18T20:00:00Z" } }); const ff = fakeFetch(5);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await rejects("bulk read while the shared breaker is open: refused", MdapiGateClosedError, () => withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/2`)));
    eq("...without a request", ff.urls.length, 0);
    const st = await mdapiFetch(`${PROD}/admin/matches/1`);
    eq("a staff read does not consult the shared breaker (no network call)", [st.status, ff.urls.length], [200, 1]);
    const w = await mdapiFetch(`${PROD}/admin/matches/3`, { method: "PUT", body: "{}" });
    eq("a write still goes (the breaker is for reads)", [w.status, ff.urls.length], [200, 2]);
    restore();
  }
  {
    const s = fakeStore(); const ff = fakeFetch(5, 503, "<html>Application error</html>");
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const r = await withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/9`));
    await sleep(5);
    eq("a bulk 503 comes back to the caller as a 503", r.status, 503);
    eq("...and is reported to the shared breaker as a failure", s.reports, [{ lane: "bulk", ok: false }]);
    restore();
  }
  {
    const s = fakeStore(); const ff = fakeFetch(5, 404, '{"message":"not found"}');
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/players/1`));
    await sleep(5);
    eq("a 404 is an answer, not strain: nothing reported", s.reports, []);
    restore();
  }
  {
    const s = fakeStore({ failures: 2 }); const ff = fakeFetch(5);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/1`));
    await sleep(5);
    eq("a bulk success after failures clears the shared breaker", s.reports, [{ lane: "bulk", ok: true }]);
    restore();
  }
  {
    const s = fakeStore({ failures: 0 }); const ff = fakeFetch(5);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/1`));
    await sleep(5);
    eq("a success with nothing to clear costs no report", s.reports, []);
    restore();
  }
  {
    // Staff reads: this instance's breaker. Two failures pass through; the third opens it.
    const s = fakeStore(); const ff = fakeFetch(5, 503, "<html>err</html>");
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    for (let i = 0; i < 3; i++) await mdapiFetch(`${PROD}/admin/matches/${i}`);
    eq("three staff 503s in a row: three requests sent", ff.urls.length, 3);
    await rejects("...the fourth is refused for 15 s", MdapiGateClosedError, () => mdapiFetch(`${PROD}/admin/matches/9`));
    eq("...without a request", ff.urls.length, 3);
    const w = await mdapiFetch(`${PROD}/admin/matches/9`, { method: "PUT", body: "{}" });
    eq("...while a write still goes", [w.status === 503, ff.urls.length], [true, 4]);
    eq("...and nothing staff-side reached the shared store", [s.acquires(), s.reports.length], [0, 0]);
    restore();
  }
  {
    const s = fakeStore(); let n = 0;
    const f = (async () => { n++; return new Response(n <= 2 ? "x" : '{"a":1}', { status: n <= 2 ? 503 : 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const restore = __setGateDepsForTest({ store: s.store, fetch: f, log: quiet, timeouts: T });
    await mdapiFetch(`${PROD}/a/1`); await mdapiFetch(`${PROD}/a/2`); await mdapiFetch(`${PROD}/a/3`);
    await mdapiFetch(`${PROD}/a/4`); await mdapiFetch(`${PROD}/a/5`);
    eq("two failures then a success: the count resets, nothing refused", n, 5);
    restore();
  }
  eq("bulk opens on the first failure, 15 then 30, 60, 120 minutes", BREAKER_STEPS_S.bulk, [900, 1800, 3600, 7200]);
  eq("staff opens on the third failure in a row, for seconds", BREAKER_STEPS_S.staff, [0, 0, 15, 30, 60, 120]);

  console.log("\nTIMEOUT:");
  {
    const s = fakeStore(); const ff = fakeFetch(5_000);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const t0 = Date.now();
    await rejects("a staff read that does not answer: MdapiTimeoutError", MdapiTimeoutError, () => mdapiFetch(`${PROD}/admin/matches/1`));
    eq("...at the lane timeout, not the API's pace", Date.now() - t0 < 1500, true);
    await rejects("a bulk read that does not answer: MdapiTimeoutError", MdapiTimeoutError, () => withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/2`)));
    await sleep(5);
    eq("...reported to the shared breaker as strain", s.reports, [{ lane: "bulk", ok: false }]);
    eq("...and the bulk slot given back", s.held.bulk.size, 0);
    restore();
  }

  console.log("\nDEDUPE — in flight only, never a stale copy:");
  {
    const s = fakeStore(); const ff = fakeFetch(30);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    const h = { headers: { Authorization: "Bearer abc" } };
    const [a, b] = await Promise.all([mdapiFetch(`${PROD}/admin/matches/5`, h), mdapiFetch(`${PROD}/admin/matches/5`, h)]);
    eq("two identical reads at once: one request", ff.urls.length, 1);
    eq("...both get the answer", [a.status, b.text === a.text], [200, true]);
    await Promise.all([mdapiFetch(`${PROD}/admin/matches/6`, h), mdapiFetch(`${PROD}/admin/matches/7`, h)]);
    eq("two different reads at once: two requests (positive control)", ff.urls.length, 3);
    await mdapiFetch(`${PROD}/admin/matches/5`, h);
    eq("the same read AFTER the first finished goes to the API again", ff.urls.length, 4);
    await Promise.all([mdapiFetch(`${PROD}/admin/matches/8`, { method: "PUT", body: "{}" }), mdapiFetch(`${PROD}/admin/matches/8`, { method: "PUT", body: "{}" })]);
    eq("writes are never merged", ff.urls.length, 6);
    restore();
  }

  console.log("\nWHEN THE SLOT STORE IS DOWN:");
  {
    const s = fakeStore({ down: true }); const ff = fakeFetch(5);
    const logs: string[] = [];
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: (l) => logs.push(l), timeouts: T });
    const r = await mdapiFetch(`${PROD}/admin/players/1`);
    eq("a staff read still goes (it never asks the store)", [r.status, ff.urls.length], [200, 1]);
    await rejects("a bulk read stops instead (the sync retries next run)", Error, () => withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/players?page=2`)));
    eq("...without a request", ff.urls.length, 1);
    restore();
  }

  console.log("\nONLY PRODUCTION TAKES A SLOT:");
  {
    const s = fakeStore(); const ff = fakeFetch(5);
    const restore = __setGateDepsForTest({ store: s.store, fetch: ff.f, log: quiet, timeouts: T });
    await withMdapiLane("bulk", () => mdapiFetch(`${STAGE}/admin/matches/1`));
    eq("a staging sync: sent, no slot asked for", [ff.urls.length, s.acquires()], [1, 0]);
    await withMdapiLane("bulk", () => mdapiFetch(`${PROD}/admin/matches/1`));
    eq("a production sync: a slot asked for (positive control)", s.acquires(), 1);
    restore();
  }
  eq("env from the PARSED host: a look-alike is not production", [envOfUrl(`${PROD}/x`), envOfUrl("https://playmatchday.herokuapp.com.evil.com/x"), envOfUrl(`${STAGE}/x`)], ["production", "other", "staging"]);
  eq("the slot label never carries an id", labelOf(`${PROD}/admin/players/12345/profile?email=a@b.c`), "/admin/players/:n/profile");

  console.log("\nLANES:");
  eq("a read with no lane said is a staff read", currentLane(), "staff");
  {
    const lane = await getPacedClient({ paceMs: 0, base: { get: async () => currentLane() as never } }).get("/admin/players");
    eq("every paced-client request runs in the bulk lane", lane, "bulk");
  }
  {
    const s = fakeStore(); const slow = fakeFetch(100);
    const restore = __setGateDepsForTest({ store: s.store, fetch: slow.f, log: quiet, timeouts: { ...T, write: 1000 } });
    const reads = withMdapiLane("bulk", () => mdapiFetch(`${PROD}/b/1`));
    const held = [mdapiFetch(`${PROD}/a/1`, { method: "POST" }), mdapiFetch(`${PROD}/a/2`, { method: "POST" })];
    await sleep(5);
    eq("a write inside a bulk run takes the write lane, not the bulk slot", s.held.bulk.size, 1);
    await Promise.all([...held, reads]);
    eq("...both writes went", slow.urls.filter((u) => u.includes("/a/")).length, 2);
    restore();
  }

  console.log("\nRETRIES (fetchMatchDayJson) — at most one, never after a timeout or a refusal:");
  {
    let n = 0;
    const seq = [503, 200];
    const f = (async () => { const st = seq[Math.min(n++, seq.length - 1)]; return new Response(st === 200 ? '{"ok":1}' : "<html>err</html>", { status: st, headers: { "content-type": st === 200 ? "application/json" : "text/html" } }); }) as typeof fetch;
    const restore = __setGateDepsForTest({ store: fakeStore().store, fetch: f, log: quiet, timeouts: T });
    const r = await fetchMatchDayJson<{ ok: number }>(`${PROD}/admin/matches/1`);
    eq("503 then 200: two requests, the answer returned", [n, r.ok], [2, 1]);
    restore();
  }
  {
    let n = 0;
    const f = (async () => { n++; return new Response("<html>err</html>", { status: 503, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    const restore = __setGateDepsForTest({ store: fakeStore().store, fetch: f, log: quiet, timeouts: T });
    await rejects("503 twice: it gives up", Error, () => fetchMatchDayJson(`${PROD}/admin/matches/1`));
    eq("...after exactly 2 requests (was 4)", n, 2);
    restore();
  }
  {
    const ff = fakeFetch(5_000);
    const restore = __setGateDepsForTest({ store: fakeStore().store, fetch: ff.f, log: quiet, timeouts: T });
    await rejects("a timeout is not retried", Error, () => fetchMatchDayJson(`${PROD}/admin/matches/1`));
    eq("...one request", ff.urls.length, 1);
    restore();
  }
  {
    const ff = fakeFetch(5);
    const restore = __setGateDepsForTest({ store: fakeStore({ open: { bulk: "2026-11-18T20:00:00Z" } }).store, fetch: ff.f, log: quiet, timeouts: T });
    await rejects("breaker open: refused, not retried", Error, () => withMdapiLane("bulk", () => fetchMatchDayJson(`${PROD}/admin/matches/1`)));
    eq("...zero requests", ff.urls.length, 0);
    restore();
  }
  {
    let n = 0;
    const f = (async () => { n++; return new Response("<html>err</html>", { status: 503, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    const restore = __setGateDepsForTest({ store: fakeStore().store, fetch: f, log: quiet, timeouts: T });
    await rejects("a bulk caller (maxRetries 0) gets no retry", Error, () => fetchMatchDayJson(`${PROD}/admin/matches/1`, {}, { maxRetries: 0 }));
    eq("...one request", n, 1);
    restore();
  }
  void MdapiGateBusyError;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass === 0 || fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
