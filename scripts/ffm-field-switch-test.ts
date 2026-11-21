/* FREE FIRST MATCH — THE FIELD SWITCH (src/lib/ffmFieldSwitch.ts). It writes production matches in a loop,
 * so the rules that keep it safe are asserted offline on every push: the body is the diff, only matches
 * whose value differs are sent, one at a time with the gap, LANDED needs the read-back, and the first match
 * that does not land stops the run with nothing retried. */
import { GAP_MS, matchesToChange, runFieldSwitch, switchBody, type PutResult } from "../src/lib/ffmFieldSwitch";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const up = [{ id: 1, wall: "2026-11-22T19:00", ffe: true }, { id: 2, wall: "2026-11-23T19:00", ffe: false }, { id: 3, wall: "2026-11-24T19:00", ffe: null }, { id: 4, wall: "2026-11-25T19:00", ffe: true }];

console.log("\nwhat is sent");
is("turning off sends only matches not already off (null included)", matchesToChange(up, false).map((m) => m.id), [1, 3, 4]);
is("turning on sends only matches not already on", matchesToChange(up, true).map((m) => m.id), [2, 3]);
is("the body is the diff and the source", switchBody(false), { changes: { firstMatchFreeEnabled: false }, source: "Free First Match · field switch" });

const landedPut = (value: boolean) => async (): Promise<PutResult> => ({ status: 200, body: { outcome: "landed", match: { firstMatchFreeEnabled: value } } });

(async () => {
  console.log("\nall land");
  {
    const calls: number[] = [], sleeps: number[] = [];
    const steps = await runFieldSwitch({ matches: up.slice(0, 3), value: false, put: async (id, b) => { calls.push(id); return landedPut(b.changes.firstMatchFreeEnabled)(); }, sleep: async (ms) => { sleeps.push(ms); } });
    is("each match sent once, in order", calls, [1, 2, 3]);
    is("every one LANDED (positive control)", steps.map((s) => s.state), ["landed", "landed", "landed"]);
    is("a gap before every write but the first, at least GAP_MS", sleeps, [GAP_MS, GAP_MS]);
  }
  {
    const sleeps: number[] = [];
    await runFieldSwitch({ matches: up.slice(0, 2), value: false, put: landedPut(false), sleep: async (ms) => { sleeps.push(ms); }, gapMs: 10 });
    is("a smaller gap asked for is raised to GAP_MS", sleeps, [GAP_MS]);
  }

  console.log("\nthe first one that does not land stops the run, nothing retried");
  for (const [label, put, want] of [
    ["HTTP 403", async (): Promise<PutResult> => ({ status: 403, body: { error: "Only an admin can turn the free first match on or off for a match." } }), "failed"],
    ["2xx but reads back unchanged", async (): Promise<PutResult> => ({ status: 200, body: { outcome: "landed", match: { firstMatchFreeEnabled: true } } }), "notapplied"],
    ["route says notapplied", async (): Promise<PutResult> => ({ status: 200, body: { outcome: "notapplied", match: { firstMatchFreeEnabled: true } } }), "notapplied"],
    ["route says unknown", async (): Promise<PutResult> => ({ status: 200, body: { outcome: "unknown" } }), "unknown"],
    ["fetch throws", async (): Promise<PutResult> => { throw new Error("network"); }, "unknown"],
  ] as const) {
    const calls: number[] = [];
    let n = 0;
    const steps = await runFieldSwitch({
      matches: up.slice(0, 3), value: false, sleep: async () => {},
      put: async (id, b) => { calls.push(id); n++; return n === 2 ? put() : landedPut(b.changes.firstMatchFreeEnabled)(); },
    });
    is(`${label}: 1st landed, 2nd ${want}, 3rd not sent`, steps.map((s) => s.state), ["landed", want, "not_sent"]);
    is(`${label}: the 2nd was sent once and the 3rd never`, calls, [1, 2]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail || pass === 0) process.exit(1);
})();
