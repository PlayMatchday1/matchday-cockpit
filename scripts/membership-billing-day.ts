/* MEMBERSHIP BILLING, ONE DAY AT A TIME — and two days side by side.
 *
 *   npx tsx scripts/membership-billing-day.ts 2026-08-01
 *   npx tsx scripts/membership-billing-day.ts 2026-08-01 2026-09-01
 *
 * READ ONLY. It writes nothing, anywhere. No table, no file, no Stripe object.
 *
 * ── IT HAS TWO HALVES, AND ONE OF THEM NEEDS A KEY ────────────────────────────────────────────
 * HALF A — SUPABASE, always runs. fin_revenue is the settled record: daily rollups of SUCCEEDED
 *   USD charges, already classified Membership / DPP / Strike / Private Rental by the shipped
 *   classifier. It gives attempts-that-succeeded, gross, fees, net, and city. It is DOLLARS.
 *
 * HALF B — STRIPE, runs only when STRIPE_SECRET_KEY is in the environment. fin_revenue CANNOT
 *   answer failed / refunded / disputed: stripeSync.ts:582 drops anything that is not
 *   `status === "succeeded"` before aggregating, so a declined card leaves NO row anywhere in
 *   Supabase. Failure reasons and the failed-member list only exist in Stripe.
 *
 *   STRIPE_SECRET_KEY is NOT in .env.local. Supply it for the run and do not write it to disk:
 *
 *       STRIPE_SECRET_KEY=$(op read ...) npx tsx scripts/membership-billing-day.ts 2026-09-01
 *
 *   or paste it inline in the shell. `vercel env pull` would leave every production secret in the
 *   working tree — do not use it for this.
 *
 * ── THE CLASSIFIER IS IMPORTED, NEVER RE-IMPLEMENTED ──────────────────────────────────────────
 * classifyCharge / looksLikeMembership come from financeImport.ts, the same functions the cron
 * and the CSV importer use. A second copy of "what counts as a membership charge" is how two
 * numbers that should be identical end up $36 apart.
 *
 * ── UNITS, STATED ONCE ────────────────────────────────────────────────────────────────────────
 *   Stripe charge.amount            CENTS   -> divided by 100 here, printed as DOLLARS
 *   fin_revenue gross/fees/net      DOLLARS already
 *   mdapi_subscriptions.price       DOLLARS
 *   mdapi_match_players.amount      CENTS
 * Every printed dollar figure below is DOLLARS. Every one is TAX-INCLUSIVE — see the header note
 * printed at the end of Half A.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../src/lib/supabasePagination";

/* ENV BEFORE THE CLASSIFIER, DELIBERATELY. financeImport.ts imports src/lib/supabase.ts, which
 * reads NEXT_PUBLIC_SUPABASE_URL at MODULE LOAD. ESM hoists every static import above this line,
 * so a static `import { classifyCharge }` here crashes on an undefined env before loadEnvFile has
 * run. classifyCharge is therefore imported dynamically inside halfB, after the env is loaded. */
try { process.loadEnvFile(".env.local"); } catch { /* env may already be set */ }

const DATES = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (DATES.length === 0 || DATES.length > 2) {
  console.error("usage: npx tsx scripts/membership-billing-day.ts <YYYY-MM-DD> [YYYY-MM-DD]");
  process.exit(2);
}

const sb: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string | number, n: number) => String(s).padStart(n);
const padr = (s: string | number, n: number) => String(s).padEnd(n);
const rule = (t: string) => console.log(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);

/* fin_revenue records the transaction count only in `notes` — "3 Stripe subscription txns".
 * There is no txn_count column. Parsing it is the only way to get a count out of the rollup. */
const txnsFromNotes = (n: string | null): number => {
  const m = /(\d+)\s+Stripe/.exec(String(n ?? ""));
  return m ? Number(m[1]) : 0;
};

type DayA = { date: string; byCity: Map<string, { txns: number; gross: number; fees: number; net: number }>; };

async function halfA(date: string): Promise<DayA> {
  const r = await sb.from("fin_revenue").select("*").eq("type", "Membership").eq("date", date);
  if (r.error) throw new Error(`fin_revenue read failed: ${r.error.message}`);
  const byCity = new Map<string, { txns: number; gross: number; fees: number; net: number }>();
  for (const x of (r.data ?? []) as Record<string, unknown>[]) {
    const c = String(x.city);
    const e = byCity.get(c) ?? { txns: 0, gross: 0, fees: 0, net: 0 };
    e.txns += txnsFromNotes(x.notes as string | null);
    e.gross += Number(x.gross); e.fees += Number(x.fees); e.net += Number(x.net);
    byCity.set(c, e);
  }
  return { date, byCity };
}

function printA(days: DayA[]) {
  rule("HALF A — SUCCEEDED MEMBERSHIP CHARGES (fin_revenue, DOLLARS, tax-inclusive)");
  const cities = [...new Set(days.flatMap((d) => [...d.byCity.keys()]))].sort();
  const head = ["CITY", ...days.flatMap((d) => [`${d.date} TXNS`, "GROSS", "NET"])];
  console.log(padr(head[0], 24) + days.map((d) => pad(d.date + " txns", 16) + pad("gross", 13) + pad("net", 13)).join(""));
  const tot = days.map(() => ({ txns: 0, gross: 0, fees: 0, net: 0 }));
  for (const c of cities) {
    let line = padr(c, 24);
    days.forEach((d, i) => {
      const e = d.byCity.get(c) ?? { txns: 0, gross: 0, fees: 0, net: 0 };
      tot[i].txns += e.txns; tot[i].gross += e.gross; tot[i].fees += e.fees; tot[i].net += e.net;
      line += pad(e.txns, 16) + pad(usd(e.gross), 13) + pad(usd(e.net), 13);
    });
    console.log(line);
  }
  console.log("─".repeat(78));
  console.log(padr("TOTAL", 24) + tot.map((t) => pad(t.txns, 16) + pad(usd(t.gross), 13) + pad(usd(t.net), 13)).join(""));
  console.log(padr("  fees", 24) + tot.map((t) => pad("", 16) + pad(usd(t.fees), 13) + pad("", 13)).join(""));
  if (days.length === 2) {
    const [a, b] = tot;
    console.log("─".repeat(78));
    console.log(padr("DELTA", 24) + pad("", 16) + pad("", 13) + pad("", 13)
      + pad(b.txns - a.txns, 16) + pad(usd(b.gross - a.gross), 13) + pad(usd(b.net - a.net), 13));
  }
  console.log(
    "\nNOTE ON UNITS AND TAX. These are DOLLARS and they are TAX-INCLUSIVE: fin_revenue.gross is\n" +
    "charge.amount/100 (stripeSync.ts:291) and nothing in the pipeline separates tax. The rate is\n" +
    "a flat per-city figure — proven exactly on the $1 tier, where the charge is $1.08 in Austin,\n" +
    "Houston, San Antonio and Dallas (8%), $1.09 in Atlanta and OKC (9%), $1.10 in St. Louis (10%).\n" +
    "To compare against a pre-tax MRR figure, divide by (1 + that city's rate).",
  );
}

/* ── HALF B ───────────────────────────────────────────────────────────────────────────────────
 * Everything fin_revenue structurally cannot hold. Runs only with a key. */

type FailedRow = {
  email: string | null; amountCents: number; failureCode: string | null; failureMessage: string | null;
};

async function halfB(dates: string[]): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    rule("HALF B — ATTEMPTS / FAILED / REFUNDED / DISPUTED  ·  NOT RUN");
    console.log(
      "STRIPE_SECRET_KEY is not in the environment, so this half did not run.\n" +
      "fin_revenue holds SUCCEEDED charges only — stripeSync.ts:582 drops everything else before\n" +
      "aggregating — so failed, refunded and disputed membership charges, their decline reasons,\n" +
      "and the list of members whose payment failed CANNOT be derived from Supabase at all.\n\n" +
      "Re-run with the key supplied for the run only (never written to disk):\n" +
      "    STRIPE_SECRET_KEY=sk_live_… npx tsx scripts/membership-billing-day.ts " + dates.join(" "),
    );
    return;
  }
  const { default: Stripe } = await import("stripe");
  const { classifyCharge } = await import("../src/lib/financeImport");
  const stripe = new Stripe(key);

  for (const date of dates) {
    const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const to = from + 86400;
    rule(`HALF B — EVERY MEMBERSHIP CHARGE ATTEMPT ON ${date} (Stripe, UTC day)`);

    let attempts = 0, succeeded = 0, failed = 0, refundedN = 0, disputedN = 0;
    let grossCents = 0, refundedCents = 0;
    const reasons = new Map<string, number>();
    const failedRows: FailedRow[] = [];

    /* THE SAME CLASSIFIER THE CRON USES. `type` and `description` come off the charge exactly as
     * stripeSync reads them; hasMatchId is what separates a per-match payment from a membership. */
    for await (const ch of stripe.charges.list({ created: { gte: from, lt: to }, limit: 100 })) {
      const meta = (ch.metadata ?? {}) as Record<string, string>;
      const kind = classifyCharge({
        stripeType: meta.type ?? null,
        description: ch.description ?? null,
        hasMatchId: Boolean(meta.matchId || meta.userMatchId),
      });
      if (kind !== "Membership") continue;
      if ((ch.currency ?? "").toLowerCase() !== "usd") continue;

      attempts++;
      if (ch.status === "succeeded") {
        succeeded++; grossCents += ch.amount;
        if (ch.amount_refunded > 0) { refundedN++; refundedCents += ch.amount_refunded; }
        if (ch.disputed) disputedN++;
      } else {
        failed++;
        const code = ch.failure_code ?? ch.outcome?.reason ?? "unknown";
        reasons.set(code, (reasons.get(code) ?? 0) + 1);
        failedRows.push({
          email: ch.billing_details?.email ?? ch.receipt_email ?? meta.email ?? null,
          amountCents: ch.amount,
          failureCode: ch.failure_code ?? null,
          failureMessage: ch.failure_message ?? null,
        });
      }
    }

    console.log(`  attempts   ${pad(attempts, 6)}`);
    console.log(`  succeeded  ${pad(succeeded, 6)}   gross ${usd(grossCents / 100)}  (CENTS from Stripe, printed as DOLLARS)`);
    console.log(`  failed     ${pad(failed, 6)}`);
    console.log(`  refunded   ${pad(refundedN, 6)}   ${usd(refundedCents / 100)}`);
    console.log(`  disputed   ${pad(disputedN, 6)}`);
    console.log(`  NET of refunds: ${usd((grossCents - refundedCents) / 100)}`);

    if (reasons.size) {
      console.log("\n  FAILURE REASONS");
      for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(n, 5)}  ${k}`);
    }
    if (failedRows.length) await printFailedMembers(failedRows, date);
  }
}

/* ITEM 4 — who failed, and are they still holding a future spot.
 * This is the population a removal run would act on, so it is joined out fully rather than left
 * as a count: the subscription status TODAY (which may have rolled off since), and any live spot
 * on a match that has not happened yet. */
async function printFailedMembers(rows: FailedRow[], date: string) {
  console.log(`\n  MEMBERS WHOSE ${date} MEMBERSHIP PAYMENT FAILED`);
  const emails = new Set(rows.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean));

  const subs = await selectAll<Record<string, unknown>>(() =>
    sb.from("mdapi_subscriptions")
      .select("user_id, member_email, city_identifier, price, status, canceled_at")
      .order("membership_id"),
  );
  const byEmail = new Map<string, Record<string, unknown>>();
  for (const s of subs) {
    const e = String(s.member_email ?? "").toLowerCase();
    if (!e || !emails.has(e)) continue;
    // Keep the ACTIVE row if the person has one, else the latest cancellation — same collapse
    // rule as Members by City.
    const prev = byEmail.get(e);
    if (!prev || (s.status === "ACTIVE" && prev.status !== "ACTIVE")) byEmail.set(e, s);
  }

  /* FUTURE SPOTS. A match "has not happened yet" by WALL CLOCK: mdapi_matches.start_date carries
   * a Z it does not mean, so it is compared as TEXT against today's YYYY-MM-DD. A Date here would
   * re-shift a late-evening match across midnight. Cancelled rows and fakes do not count. */
  const todayYmd = new Date().toISOString().slice(0, 10);
  const userIds = [...byEmail.values()].map((s) => Number(s.user_id)).filter(Boolean);
  const spots = new Map<number, number>();
  if (userIds.length) {
    const players = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_match_players")
        .select("user_id, match_api_id, is_cancelled, user_is_fake_player, deleted_at")
        .in("user_id", userIds).order("api_id"),
    );
    const matchIds = [...new Set(players.map((p) => Number(p.match_api_id)))];
    const future = new Set<number>();
    for (let i = 0; i < matchIds.length; i += 500) {
      const m = await sb.from("mdapi_matches").select("api_id, start_date, is_cancelled")
        .in("api_id", matchIds.slice(i, i + 500));
      for (const x of (m.data ?? []) as Record<string, unknown>[]) {
        if (x.is_cancelled === true) continue;
        if (String(x.start_date ?? "").slice(0, 10) >= todayYmd) future.add(Number(x.api_id));
      }
    }
    for (const p of players) {
      if (p.is_cancelled === true || p.user_is_fake_player === true || p.deleted_at) continue;
      if (!future.has(Number(p.match_api_id))) continue;
      spots.set(Number(p.user_id), (spots.get(Number(p.user_id)) ?? 0) + 1);
    }
  }

  console.log(`    ${padr("user_id", 10)}${padr("city", 7)}${pad("price", 7)}  ${padr("status today", 14)}${pad("future spots", 13)}  reason`);
  for (const r of rows.sort((a, b) => b.amountCents - a.amountCents)) {
    const s = byEmail.get((r.email ?? "").toLowerCase());
    if (!s) {
      console.log(`    ${padr("UNKNOWN", 10)}${padr("—", 7)}${pad(usd(r.amountCents / 100), 7)}  ${padr("no sub row", 14)}${pad("—", 13)}  ${r.failureCode ?? ""}`);
      continue;
    }
    const uid = Number(s.user_id);
    console.log(
      `    ${padr(uid, 10)}${padr(String(s.city_identifier ?? "—"), 7)}${pad("$" + s.price, 7)}  ` +
      `${padr(String(s.status), 14)}${pad(spots.get(uid) ?? 0, 13)}  ${r.failureCode ?? ""} ${r.failureMessage ?? ""}`.slice(0, 200),
    );
  }
  const holding = [...byEmail.values()].filter((s) => (spots.get(Number(s.user_id)) ?? 0) > 0).length;
  console.log(`\n    ${byEmail.size} of ${rows.length} failed charges resolved to a subscription row; ${holding} are still holding at least one future spot.`);
  console.log(`    City is city_identifier from mdapi_subscriptions — fin_revenue's own city is a Stripe-metadata prefix map and the two are separate joins.`);
}

async function main() {
  const a = await Promise.all(DATES.map(halfA));
  printA(a);
  await halfB(DATES);
  console.log("\nRead-only: this script wrote nothing.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : String(e)); process.exit(1); });
