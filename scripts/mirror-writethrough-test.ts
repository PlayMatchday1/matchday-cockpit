// THE MIRROR WRITE-THROUGH — one implementation, every caller, and the four rules that keep it safe.
//
// ITEMISED: this file was veo-mirror-writethrough-test.ts and asserted on an INLINE block in the
// match-edit route, because the write-through lived there. Manager assignment needed the same
// thing, so it moved to src/lib/mirrorWriteThrough.ts and these assertions moved with it — from
// "the route contains this code" to "the function behaves, and every caller uses it".
//
// mdapi_matches is a read-only mirror of PRODUCTION MatchDay refreshed by ONE daily cron
// (vercel.json "0 11 * * *"). Every Clubhouse screen reads names and managers from it, so a write
// that does not refresh the row is invisible for up to ~24 hours. Measured: 6 of 6 landed Veo name
// writes were still absent from the mirror an hour later.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/mirror-writethrough-test.ts

import { readFileSync } from "node:fs";
import { refreshMatchMirror } from "../src/lib/mirrorWriteThrough";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

// A Supabase stand-in that records what it was asked to write.
function fakeSb() {
  const calls: { table: string; patch: Record<string, unknown>; id: unknown }[] = [];
  const sb = {
    from(table: string) {
      return { update(patch: Record<string, unknown>) {
        return { async eq(_c: string, id: unknown) { calls.push({ table, patch, id }); return { error: null }; } };
      } };
    },
  };
  return { sb: sb as never, calls };
}

const AFTER_NAME = { name: "\u{1F3A5} NEMP - Field 13", managerId: 7, manager: { firstName: "Abra", lastName: "Cadabra", email: "a@x.com" } };
const AFTER_MGR = { name: "NEMP - Field 13", managerId: 42, manager: { firstName: "Chris", lastName: "Padilla", email: "c@x.com" } };

// tsx emits CJS here, where top-level await is unavailable — the whole run lives in main().
async function main() {
  console.log("a LANDED write refreshes the row from the READ-BACK value:");
  {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 18115, ["name"], AFTER_NAME, "landed");
    is("it reports refreshed", r.refreshed, true);
    is("  …one update, to mdapi_matches, keyed on api_id", { n: calls.length, t: calls[0]?.table, id: calls[0]?.id }, { n: 1, t: "mdapi_matches", id: 18115 });
    is("  …carrying the read-back name and nothing else", calls[0].patch, { name: "\u{1F3A5} NEMP - Field 13" });
  }
  {
    const { sb, calls } = fakeSb();
    await refreshMatchMirror(sb, "production", 991, ["managerId"], AFTER_MGR, "landed");
    // The manager NAME is denormalised into the mirror: an id-only update would show the new id
    // beside the OLD person on every screen that reads those columns.
    is("a manager assignment refreshes id AND the denormalised name/email", calls[0].patch,
       { manager_id: 42, manager_first_name: "Chris", manager_last_name: "Padilla", manager_email: "c@x.com" });
  }

  console.log("\nand it refuses, in each of the three ways it must:");
  for (const [label, env, outcome] of [
    ["a FAILED write", "production", "failed"],
    ["a NOT APPLIED write", "production", "not applied"],
    ["an UNKNOWN write", "production", "unknown"],
    ["a STAGING write, even when it landed", "staging", "landed"],
  ] as [string, string, string][]) {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, env, 18115, ["name"], AFTER_NAME, outcome);
    is(`  ${label} → no update at all`, { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
  }
  // POSITIVE CONTROL for those four zeros: the same harness DOES record an update when it should.
  {
    const { sb, calls } = fakeSb();
    await refreshMatchMirror(sb, "production", 1, ["name"], AFTER_NAME, "landed");
    is("  control — the harness records an update when the write is production + landed", calls.length, 1);
  }

  console.log("\nit never guesses:");
  {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 1, ["registrationPrice"], { registrationPrice: 1200 }, "landed");
    is("a field the mirror does not carry is skipped", { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
  }
  {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 1, ["name"], {}, "landed");
    is("a key the re-read did NOT return is skipped rather than nulled", { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
  }
  {
    // Best-effort: a mirror error must never surface as a failure of the write that already landed.
    const sb = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: "boom" } }) }) }) } as never;
    const r = await refreshMatchMirror(sb, "production", 1, ["name"], AFTER_NAME, "landed");
    is("a mirror failure is reported, not thrown", { refreshed: r.refreshed, reason: r.reason }, { refreshed: false, reason: "boom" });
  }

  console.log("\nevery caller uses the SHARED function — no second implementation:");
  for (const [label, f] of [
    ["match edit (name, managers, everything)", "src/app/api/matchday/[env]/matches/[id]/route.ts"],
    ["city manager assign", "src/app/api/manager-pay/city-week/route.ts"],
  ] as [string, string][]) {
    const code = stripComments(readFileSync(f, "utf8"));
    is(`  ${label} calls refreshMatchMirror`, /refreshMatchMirror\(/.test(code), true);
    is(`  ${label} does not update mdapi_matches itself`, /from\("mdapi_matches"\)[\s\S]{0,40}\.update\(/.test(code), false);
  }
  {
    // The env gate must be the FIRST thing the function checks — an ungated refresh rewrites a
    // production row from a staging action, which nearly shipped once.
    const lib = stripComments(readFileSync("src/lib/mirrorWriteThrough.ts", "utf8"));
    is("the env gate precedes the outcome gate, which precedes the update",
       lib.indexOf('env !== "production"') < lib.indexOf('outcome !== "landed"')
       && lib.indexOf('outcome !== "landed"') < lib.indexOf('from("mdapi_matches")'), true);
    is("  control — the scan sees all three markers", 
       lib.includes('env !== "production"') && lib.includes('outcome !== "landed"') && lib.includes('from("mdapi_matches")'), true);
  }
  {
    // The assign route must refresh BEFORE it responds, or the client's refetch reads the stale row.
    const code = stripComments(readFileSync("src/app/api/manager-pay/city-week/route.ts", "utf8"));
    is("the assign route refreshes the mirror BEFORE it responds",
       code.indexOf("refreshMatchMirror(") < code.indexOf("return Response.json({\n      ok: true"), true);
  }

}

await_main();
function await_main() { void main().then(() => {
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
}); }
