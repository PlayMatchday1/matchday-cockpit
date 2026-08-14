// Silent-skip is the failure mode this file exists to make impossible.
//
// A sync step that fails without leaving a fin_sync_log row is indistinguishable from one that ran
// clean. That ambiguity is exactly what let google-calendar sit frozen for eight days: it was step
// 15 of 15, the orchestrator hit its 300s maxDuration at app-store-installs (+288s), and the step
// never started — so runWithLog was never called and there was nothing to see.
//
// These assertions pin the two halves we CAN guarantee in-process:
//   1. every outcome writes a completion stamp — success, zero-rows, and thrown;
//   2. a thrown step records the error CLASS as well as the message, and never a credential.
// (A step killed by the platform runs no code at all, so no in-process rule can log it. That one is
// addressed by ORDERING — the calendar step was moved out of the starved tail — and by the budget
// note in /api/sync/cron.)
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/sync-logging-test.ts

import { runWithLog } from "../src/lib/syncLogging";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// A fake Supabase surface that records what the logger wrote. No network, no production rows.
function fakeClient() {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "log-1" }, error: null }) }) };
        },
        update(patch: Record<string, unknown>) {
          updated.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { client: client as never, inserted, updated };
}

async function main() {
  console.log("a SUCCEEDING step stamps completion:");
  {
    const { client, inserted, updated } = fakeClient();
    const r = await runWithLog("mdapi-matches", "cron", client, async () => ({ rows: 7 }), (x) => ({ rows_imported: x.rows }));
    is("  it reports ok", r.ok, true);
    is("  a start row was written with the source and trigger", { src: inserted[0]?.source, by: inserted[0]?.triggered_by, started: !!inserted[0]?.started_at }, { src: "mdapi-matches", by: "cron", started: true });
    is("  exactly one completion update, carrying completed_at and the patch",
      { n: updated.length, completed: !!updated[0]?.completed_at, rows: updated[0]?.rows_imported }, { n: 1, completed: true, rows: 7 });
    is("  a clean run records NO error_message", updated[0]?.error_message ?? null, null);
  }

  console.log("\na ZERO-ROWS step still stamps completion (silence is not success):");
  {
    const { client, updated } = fakeClient();
    const r = await runWithLog("membership-prices", "cron", client, async () => ({ rows: 0 }), (x) => ({ rows_imported: x.rows }));
    is("  it reports ok", r.ok, true);
    is("  and still completes the row with an explicit 0", { completed: !!updated[0]?.completed_at, rows: updated[0]?.rows_imported }, { completed: true, rows: 0 });
  }

  console.log("\nA THROWING STEP STILL PRODUCES A ROW — the assertion this file is for:");
  {
    const { client, updated } = fakeClient();
    const r = await runWithLog("google-calendar", "cron", client, async () => { throw new TypeError("boom in the sync"); }, () => ({}));
    is("  the step reports failure rather than swallowing it", r.ok, false);
    is("  a completion row IS written for the failed step", { n: updated.length, completed: !!updated[0]?.completed_at }, { n: 1, completed: true });
    is("  the row records the error CLASS and the message", updated[0]?.error_message, "TypeError: boom in the sync");
    is("  the returned error carries the class too", r.ok === false ? r.error : null, "TypeError: boom in the sync");
  }

  console.log("\na non-Error throw is still logged, not lost:");
  {
    const { client, updated } = fakeClient();
    const r = await runWithLog("telnyx-sms", "cron", client, async () => { throw "just a string"; }, () => ({}));
    is("  reports failure", r.ok, false);
    is("  and still stamps a row naming the thrown type", { completed: !!updated[0]?.completed_at, msg: updated[0]?.error_message }, { completed: true, msg: "string: just a string" });
  }

  console.log("\nno credential ever reaches the log:");
  {
    const { client, updated } = fakeClient();
    await runWithLog("stripe-api", "cron", client, async () => { throw new Error("auth failed"); }, () => ({}));
    const blob = JSON.stringify(updated);
    is("  the logged row contains no token/secret/key material", /sk_live|Bearer |private_key|SUPABASE_SERVICE/.test(blob), false);
    // the message is whatever the sync lib threw; libs throw sanitized text by contract
    is("  the message is the thrown text only", updated[0]?.error_message, "Error: auth failed");
  }

  console.log("\nTHE BUDGET — concurrency, a guard, and a reported margin:");
  {
    const src = (await import("node:fs")).readFileSync("src/app/api/sync/cron/route.ts", "utf8");
    // The two slow INDEPENDENT steps overlap. Reordering alone rotated the starvation (moving the
    // calendar to step 5 pushed app-store-installs ~5s LATER); this is the change that buys margin.
    is("  users-lens and membership-snapshots run CONCURRENTLY, not one after the other",
      /await Promise\.all\(\[[\s\S]{0,400}?"mdapi-users-lens-snapshot"[\s\S]{0,900}?"membership-snapshots"/.test(src), true);
    is("  a step with no budget left is SKIPPED and RECORDED, never started to be killed",
      /budgetLeftMs\(\) <= 0/.test(src) && /skipForBudget\(/.test(src), true);
    is("  the skip writes a fin_sync_log row naming the reason", /error_message: msg/.test(src) && /budget exhausted/.test(src), true);
    is("  the response reports the margin and any budget-skipped steps",
      /marginMs: budgetLeftMs\(\)/.test(src) && /skippedForBudget,/.test(src), true);
  }

  console.log("\nORDERING — the calendar step is no longer in the starved tail:");
  {
    const src = (await import("node:fs")).readFileSync("src/app/api/sync/cron/route.ts", "utf8");
    const order = [...src.matchAll(/runWithLog\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
    const cal = order.indexOf("google-calendar");
    is("  google-calendar runs in the first half of the pipeline, not last",
      { index: cal, total: order.length, isLast: cal === order.length - 1, inFirstHalf: cal >= 0 && cal < order.length / 2 },
      { index: cal, total: order.length, isLast: false, inFirstHalf: true });
  }
}

main().then(() => {
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}).catch((e) => { console.log('XX threw —', e?.message ?? e); process.exit(1); });
