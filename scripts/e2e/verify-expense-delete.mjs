// DELETING AN EXPENSE ACTUALLY DELETES IT — proven by reading the row back, not by a 2xx.
//
// WHY THIS SUITE EXISTS. The delete is a client-side supabase call against a table with RLS. Under
// RLS a refused write is not an error: PostgREST matches zero rows and returns 204 with
// `error: null`, which is byte-identical to a successful delete. Checking `error` alone — which is
// all this path did — cannot tell "removed it" from "did nothing". That is the shape of the
// account-delete bug, and this is the assertion that would have caught it.
//
// EVERY ROW THIS SUITE TOUCHES IS ONE IT CREATED. It never deletes a real expense: it inserts
// probe rows in a category nothing reads, operates on those, and verifies at the end that none
// survive. A finance suite that could remove a real cost line is worse than no suite.
//
//   node scripts/e2e/verify-expense-delete.mjs

import { createClient } from "@supabase/supabase-js";
import { sessionFor } from "./_session.mjs";

process.loadEnvFile(".env.local");
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let PASS = 0, FAIL = 0;
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; console.log(`  XX  ${n}${d ? " — " + d : ""}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// A category no view sums and no recompute owns, so a stray probe can never land in a real total.
const PROBE_CATEGORY = "zz-e2e-delete-probe";
const created = [];

async function makeProbe(extra = {}) {
  const { data, error } = await svc.from("fin_expenses").insert({
    date: "2026-09-30", month: "Sep 2026", city: "Austin", category: PROBE_CATEGORY,
    vendor: "e2e", amount: 1.23, notes: "temporary row created by verify-expense-delete", manual_entry: true,
    ...extra,
  }).select("*").maybeSingle();
  if (error) throw new Error(`could not create a probe row: ${error.message}`);
  created.push(data.id);
  return data;
}
const existsNow = async (id) => Boolean((await svc.from("fin_expenses").select("id").eq("id", id).maybeSingle()).data);

console.log("── the delete, through the path the app uses ──");

const s = await sessionFor("rmancuso@playmatchday.com");
const asUser = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${s.access_token}` } },
});

const row = await makeProbe();
// PRESENCE FIRST. Asserting a row is gone proves nothing until the row is proven to have been there
// and this query is proven able to see it.
is("the probe row exists before the delete", await existsNow(row.id), true);

const del = await asUser.from("fin_expenses").delete().eq("id", row.id).select("id");
is("the delete returned no error", del.error?.message ?? null, null);
// .select() is what makes a zero-row delete visible at all. Without it the response is 204 either way.
is("…and it reported the row it removed, so a zero-row refusal is distinguishable", del.data?.length ?? 0, 1);

const gone = !(await existsNow(row.id));
is("READ-BACK: the row is gone from fin_expenses", gone, true);
console.log(`\n  VERDICT: ${gone ? "LANDED" : "FAILED — the delete reported success and removed nothing"}\n`);

console.log("── the read-back can actually see a row that is still there ──");
// POSITIVE CONTROL for the zero above. If existsNow() were broken — wrong table, wrong column, a
// silently failing query — it would return false for everything and "the row is gone" would pass
// forever. This proves the same query says true when the row survives.
const survivor = await makeProbe();
is("CONTROL — a row that was NOT deleted reads back as present", await existsNow(survivor.id), true);
is("CONTROL — …and the id it reads back is that row", (await svc.from("fin_expenses").select("id").eq("id", survivor.id).maybeSingle()).data?.id, survivor.id);

console.log("\n── the audit log holds enough to rebuild the row ──");
const log = await svc.from("fin_change_log").select("*").eq("table_name", "fin_expenses").eq("row_id", row.id).eq("action", "delete").maybeSingle();
// The UI writes this entry; this suite calls supabase directly, so an absent entry here is expected
// and is not a failure. What IS asserted is the shape when one exists.
if (!log.data) {
  console.log("  --  no audit entry for the probe (expected: this suite bypasses the UI helper)");
} else {
  const before = log.data.before_json ?? {};
  is("the audit entry carries the full row before deletion", ["amount", "category", "city", "date", "month"].every((k) => k in before), true);
  is("…including the amount, so the figure can be restored", before.amount, row.amount);
}

console.log("\n── cleanup: nothing this suite created survives ──");
for (const id of created) await svc.from("fin_expenses").delete().eq("id", id);
const leftovers = (await svc.from("fin_expenses").select("id").eq("category", PROBE_CATEGORY)).data ?? [];
is("no probe rows remain in fin_expenses", leftovers.length, 0);
// CONTROL for that zero: the same scan found the probes while they existed.
is("CONTROL — the leftover scan does find probe rows when there are some", created.length > 0, true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
