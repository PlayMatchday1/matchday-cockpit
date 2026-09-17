// Zero the two split-rate twin legs. Follow-on to the 2026 field cost load (45b2f2c).
//
//   node scripts/zero-split-rate-twins.mjs            dry run
//   node scripts/zero-split-rate-twins.mjs --commit    writes
//
// WHY THESE TWO LEGS CARRY MONEY NOBODY INVOICED. A match's venue resolves in two steps: field_id
// through fin_venue_fields, then resolveSplitRateVenueId, which can re-route the row to a different
// venue. No mdapi field links to either secondary leg, so the routing is the ONLY way a match
// arrives there. Soccer Central routes by capacity (>22 players, 317 matches) and ATH Katy by day of
// week (Sunday, 30 matches). The bank shows one payee per facility and the reconciled figure is all
// of it: $41,736.84 for Soccer Central Jan-Aug, $12,740.00 for ATH. The word "tournament" appears
// nowhere in the Sports Field Fees account, 2023 through 2026. So the $57,060 modelled on venue 53
// and the $4,800 on venue 23 were never invoiced by anyone.
//
// The load put each facility's whole bank figure on its PRIMARY leg. This zeros the secondary.
import fs from "node:fs";

const COMMIT = process.argv.includes("--commit");
const SNAPSHOT = "fin_venue_cost_overrides_bak_20260917_twins";
const CREATED_BY = "field-cost-2026-reconciliation";   // same provenance string as the load
const TWINS = { 53: "Soccer Central Tournament", 23: "ATH Katy Sunday" };
const REASON = "Split-rate twin leg. The field fee is billed on the primary venue and loaded there.";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const MONTHS = MON.map((m) => `${m} 2026`);

// per_match_rate goes to zero for the same reason it did at Onion Creek and LBJ: an override only
// covers the months it covers, and September onward would start inventing this money again with
// nobody remembering why.
const RATE_ZERO = [23, 53];

/* THE ONE COLUMN THAT IS NOT SYMMETRIC, AND WHY IT IS PINNED RATHER THAN COMPENSATED.
 *
 * legPerMatchUnitCost resolves in order: the leg's own cost_per_match, THEN a secondary leg's
 * per_match_rate, THEN the primary's cost_per_match. Venue 53 has cost_per_match = 180, so it wins
 * first and zeroing per_match_rate cannot reach the Cost page. Venue 23's cost_per_match is NULL,
 * so the Cost page has been borrowing its BILLING rate through that second rule all along. Zero the
 * rate and that fallback returns 0, dropping the ATH Katy group's normalized cost from $20,340 to
 * $15,540 and its per-match figure from $144.26 to $110.21 — the Cost page moving for a reason that
 * has nothing to do with this change.
 *
 * Setting cost_per_match = 160 WRITES DOWN the number that was already in use. It is not a fresh
 * cost judgement and it is not a plug: it makes venue 23 structurally identical to venue 53, where
 * the column is already filled in, and the test is that it changes no rendered figure. */
const COST_PIN = { 23: 160 };

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const U = env.NEXT_PUBLIC_SUPABASE_URL;
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
  "Content-Type": "application/json",
};
const money = (n) => (Number(n) < 0 ? "-" : "") + "$" +
  Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rows = [];
  for (const [id, name] of Object.entries(TWINS)) {
    for (const month of MONTHS) {
      rows.push({ venue_id: Number(id), month, override_amount: 0, reason: REASON, created_by: CREATED_BY, _name: name });
    }
  }
  console.log(`override rows to write : ${rows.length}  (${Object.keys(TWINS).length} legs x 8 months)`);
  console.log(`distinct (venue, month): ${new Set(rows.map((r) => `${r.venue_id}|${r.month}`)).size}  (must equal the row count)`);

  const before = await (await fetch(
    `${U}/rest/v1/fin_venues?select=id,venue_name,per_match_rate,cost_per_match&id=in.(23,53)&order=id`, { headers: H })).json();
  console.log("\nfin_venues before:");
  for (const v of before) console.log(`  ${v.id} ${v.venue_name.padEnd(28)} per_match_rate=${v.per_match_rate}  cost_per_match=${v.cost_per_match}`);

  const snap = await fetch(`${U}/rest/v1/${SNAPSHOT}?select=id`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const haveSnap = snap.status === 200 || snap.status === 206;
  console.log(`\nsnapshot ${SNAPSHOT}: ${haveSnap ? "PRESENT " + snap.headers.get("content-range") : "ABSENT (status " + snap.status + ")"}`);

  if (!COMMIT) { console.log("\nDRY RUN. Nothing written. Pass --commit to write."); return; }
  if (!haveSnap) throw new Error(`refusing to write: the snapshot ${SNAPSHOT} does not exist`);

  // 1. the 16 overrides
  const res = await fetch(`${U}/rest/v1/fin_venue_cost_overrides?on_conflict=venue_id,month`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows.map(({ _name, ...r }) => r)),
  });
  if (!res.ok) throw new Error(`override write failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const written = await res.json();
  console.log(`\nWROTE ${written.length} override rows, status ${res.status}`);

  // 2. per_match_rate = 0 on both legs
  const r2 = await fetch(`${U}/rest/v1/fin_venues?id=in.(${RATE_ZERO.join(",")})`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ per_match_rate: 0 }),
  });
  if (!r2.ok) throw new Error(`rate zero failed ${r2.status}: ${(await r2.text()).slice(0, 300)}`);
  console.log(`WROTE per_match_rate = 0 on ${(await r2.json()).length} venues`);

  // 3. the pin on venue 23 only
  for (const [id, val] of Object.entries(COST_PIN)) {
    const r3 = await fetch(`${U}/rest/v1/fin_venues?id=eq.${id}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ cost_per_match: val }),
    });
    if (!r3.ok) throw new Error(`cost pin failed ${r3.status}: ${(await r3.text()).slice(0, 300)}`);
    console.log(`WROTE cost_per_match = ${val} on venue ${id} (${(await r3.json()).length} row)`);
  }

  // 4. the audit trail for the fin_venues edits. The 16 overrides carry their provenance in
  // created_by and reason exactly as the 184-row load did, and are not retro-logged here; the
  // column edits are judgements and get a note each. Both table names are on the fin_change_log
  // allowlist (fin_venues 275 existing rows, fin_venue_cost_overrides 132) — verified by probe, and
  // a name outside it is refused with 23514.
  const B = Object.fromEntries(before.map((v) => [v.id, v]));
  const log = [
    ...RATE_ZERO.map((id) => ({
      table_name: "fin_venues", row_id: id, action: "update", changed_by: CREATED_BY,
      before_json: { per_match_rate: B[id].per_match_rate },
      after_json: { per_match_rate: 0 },
      note: "Split-rate twin leg zeroed. The facility's field fee is billed on the primary leg and "
          + "the 2026 reconciliation loaded it there; nothing was ever invoiced against this leg. "
          + "The rate goes to zero as well as the months, so Sep 2026 onward cannot re-invent it.",
    })),
    ...Object.entries(COST_PIN).map(([id, val]) => ({
      table_name: "fin_venues", row_id: Number(id), action: "update", changed_by: CREATED_BY,
      before_json: { cost_per_match: B[id].cost_per_match },
      after_json: { cost_per_match: val },
      note: `PINNING, NOT A FRESH COST JUDGEMENT. ${val} is the number the Cost page was already `
          + "using: with cost_per_match null, legPerMatchUnitCost falls through to a secondary "
          + "leg's per_match_rate, which was 160. Zeroing that rate would have dropped this "
          + "group's per-match cost from $144.26 to $110.21 for no real reason. Writing 160 down "
          + "makes the column explicit and makes this leg match venue 53, where it is already set. "
          + "The test is that it changes no rendered figure. Do not read it as a new estimate.",
    })),
  ];
  const r4 = await fetch(`${U}/rest/v1/fin_change_log`, {
    method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(log),
  });
  if (!r4.ok) throw new Error(`change log failed ${r4.status}: ${(await r4.text()).slice(0, 400)}`);
  console.log(`WROTE ${(await r4.json()).length} fin_change_log rows`);

  const after = await (await fetch(
    `${U}/rest/v1/fin_venues?select=id,venue_name,per_match_rate,cost_per_match&id=in.(23,53)&order=id`, { headers: H })).json();
  console.log("\nfin_venues after:");
  for (const v of after) console.log(`  ${v.id} ${v.venue_name.padEnd(28)} per_match_rate=${v.per_match_rate}  cost_per_match=${v.cost_per_match}`);
  console.log(`\noverride rows now on the twins: ${written.length}, all ${money(0)}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
