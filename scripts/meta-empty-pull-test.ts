import "server-only"; // no-op under --conditions=react-server
/* AN EMPTY PULL MUST NOT EMPTY THE LEDGER — DRIVEN, NOT REASONED ABOUT.
 *
 * THE DEFECT. fin_expenses' DELETE covers every owned row from 2026-08-01. The INSERT was built
 * from `daily`, the rows just fetched from Meta. If Meta returned NOTHING — an outage, a revoked
 * or expired system-user token, a paused account, a 200 with an empty data array — `daily` was
 * empty, the rollup produced no rows, and the delete still ran. Every Meta expense row gone, and
 * the route returned 200 with a cheerful `rows_replaced: 0`.
 *
 * WHY THIS SUITE EXISTS ALONGSIDE meta-ad-spend-test. That one asserts the ARITHMETIC — that
 * monthlyExpenseRows over the store returns the whole month. This one asserts the PATH: it runs
 * syncMetaAdSpend itself against a Graph that answers with nothing and a fake Supabase that
 * records every statement, and checks what actually reached the database. The reasoning was that
 * reading the store makes an empty pull a no-op; the difference between that being true and being
 * believed is this file.
 *
 * NO NETWORK, NO CLOCK, NO DATABASE. fetch is stubbed and the client is a recorder, so it runs in
 * the node guards on every push like the rest of them.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/meta-empty-pull-test.ts
 */
import { monthlyExpenseRows, type LedgerSourceRow } from "../src/lib/metaAdSpend";
import { syncMetaAdSpend } from "../src/lib/metaAdSpendSync";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  XX  ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ── THE TOKEN GATE RUNS FOR REAL, so the env has to look like production. Deliberately NOT equal
 * to META_ACCESS_TOKEN: syncMetaAdSpend refuses when the two match, and that refusal is a
 * different test's subject. */
process.env.META_ADS_ACCESS_TOKEN = "test-ads-token-not-a-real-one";
delete process.env.META_ACCESS_TOKEN;

type Op = { table: string; verb: string; rows?: Record<string, unknown>[]; filters: string[] };

/* A fake PostgREST builder. Chainable and thenable, because the sync awaits some chains directly
 * (`.select(...).eq().eq().gte()`) and calls `.range()` on others through selectAll. */
function makeClient(store: LedgerSourceRow[], ownedCount: number) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, verb: "", filters: [] };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    const record = (verb: string, rows?: Record<string, unknown>[]) => { op.verb = verb; op.rows = rows; ops.push(op); return self(); };
    Object.assign(chain, {
      select: (_c: string, o?: { count?: string; head?: boolean }) => record(o?.head ? "count" : "select"),
      upsert: (rows: Record<string, unknown>[]) => record("upsert", rows),
      insert: (rows: Record<string, unknown>[]) => record("insert", rows),
      delete: () => record("delete"),
      eq: (c: string, v: unknown) => { op.filters.push(`${c}=${String(v)}`); return self(); },
      gte: (c: string, v: unknown) => { op.filters.push(`${c}>=${String(v)}`); return self(); },
      order: () => self(),
      range: (lo: number, hi: number) => Promise.resolve(
        // The store, paged the way selectAll expects. One page is enough at this size; the slice
        // is real so a future widening of PAGE cannot make this silently return everything twice.
        { data: store.slice(lo, hi + 1).map((r) => ({ spend_date: r.date, market_key: r.marketKey, spend_cents: r.spendCents })), error: null },
      ),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(op.verb === "count" ? { count: ownedCount, error: null }
          : op.verb === "delete" ? { count: ownedCount, error: null }
          : { data: [], error: null }).then(res),
    });
    return chain;
  };
  return { client: { from } as never, ops };
}

/** Graph, answering every insights call with an empty data array. */
function stubGraph(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname + (u.searchParams.get("breakdowns") ? "?breakdowns" : u.searchParams.get("date_preset") ? "?lifetime" : ""));
    const json =
      u.pathname.endsWith("/me/adaccounts")
        ? { data: [{ id: "act_1", name: "MatchDay", account_id: "1", currency: "USD", timezone_name: "America/Bogota" }] }
        : u.searchParams.get("date_preset") === "maximum"
          ? { data: [{ spend: "31888.09" }] }
          : { data: [] };   // THE WHOLE POINT: the windowed calls return nothing at all.
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

/** A full August plus a partial September already in the daily store. */
const STORE: LedgerSourceRow[] = [];
for (let d = 1; d <= 31; d++) STORE.push({ date: `2026-08-${String(d).padStart(2, "0")}`, marketKey: "HTX", spendCents: 10000 });
for (let d = 1; d <= 18; d++) STORE.push({ date: `2026-09-${String(d).padStart(2, "0")}`, marketKey: "ATL", spendCents: 10000 });
const STORE_CENTS = STORE.reduce((s, r) => s + r.spendCents, 0);

/* TOP-LEVEL AWAIT IS NOT AVAILABLE HERE — tsx transforms these suites to CJS, so every other
 * script in scripts/ is written this way too. */
async function main() {
console.log("META — AN EMPTY PULL MUST NOT EMPTY THE LEDGER\n");

console.log("Meta returns nothing");
const g = stubGraph();
const { client, ops } = makeClient(STORE, 8);
const res = await syncMetaAdSpend(client, "2026-09-18");

is("the pull really did come back empty", [res.daysPulled, res.marketRows, res.spendCents], [0, 0, 0]);
// POSITIVE CONTROL: the sync actually reached Meta and asked the right questions, rather than
// failing early somewhere and producing zeroes for an unrelated reason.
is("control — it called adaccounts, lifetime spend, the breakdown and the totals",
  g.calls, ["/v25.0/me/adaccounts", "/v25.0/act_1/insights?lifetime", "/v25.0/act_1/insights?breakdowns", "/v25.0/act_1/insights"]);

console.log("\nnothing was written to the daily store, and everything was read back out of it");
is("no upsert was attempted, because there was nothing to upsert",
  ops.filter((o) => o.verb === "upsert").length, 0);
is("the store was read for the ledger", res.ledgerSourceRows, STORE.length);

console.log("\nthe ledger was rewritten, not emptied");
const del = ops.find((o) => o.table === "fin_expenses" && o.verb === "delete");
const ins = ops.find((o) => o.table === "fin_expenses" && o.verb === "insert");
is("the DELETE still ran, with all three ownership clauses on the statement",
  del?.filters, ["vendor=Meta", "manual_entry=false", "date>=2026-08-01"]);
is("…and an INSERT ran after it", ins != null, true);
const inserted = (ins?.rows ?? []) as { month: string; amount: number; city: string | null; vendor: string; manual_entry: boolean }[];
is("every owned month came back", [...new Set(inserted.map((r) => r.month))].sort(), ["Aug 2026", "Sep 2026"]);
is("carrying the store's whole value, to the cent",
  Math.round(inserted.reduce((s, r) => s + r.amount, 0) * 100), STORE_CENTS);
is("…and still stamped as ours, so the next run can find them",
  [...new Set(inserted.map((r) => `${r.vendor}|${r.manual_entry}`))], ["Meta|false"]);
is("the result reports what it wrote", res.expenseRowsWritten, inserted.length);

/* THE CONTROL THAT MAKES THE ASSERTIONS ABOVE MEAN SOMETHING. This is the OLD code's answer,
 * computed here rather than described: the ledger built from the empty pull. If it ever stops
 * being zero, the pull is no longer empty and this suite is testing nothing. */
console.log("\nthe pre-fix arithmetic, for contrast");
is("control — building the ledger from the empty pull gives NO rows at all", monthlyExpenseRows([]).length, 0);
is("control — which is a different answer from the one above", inserted.length > 0, true);

/* AND THE CONTROL THAT PROVES THE HARNESS CAN SEE A WIPE. With an empty store as well as an empty
 * pull there is genuinely nothing to write, so the insert must be absent. An assertion that cannot
 * fail is not an assertion, and "the ledger was rewritten" would pass on a fake that always
 * reported rows. */
console.log("\nwith an EMPTY store too, there is correctly nothing to write");
stubGraph();
const { client: c2, ops: ops2 } = makeClient([], 8);
const res2 = await syncMetaAdSpend(c2, "2026-09-18");
is("no insert is attempted", ops2.filter((o) => o.verb === "insert").length, 0);
is("…and the delete still ran, so the harness would have SEEN a wipe if one happened",
  ops2.filter((o) => o.table === "fin_expenses" && o.verb === "delete").length, 1);
is("the result says zero rows written", [res2.expenseRowsWritten, res2.ledgerSourceRows], [0, 0]);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main().catch((e) => { console.log("  XX  the suite itself threw:", e instanceof Error ? e.message : String(e)); process.exit(1); });
