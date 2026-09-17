// Load the 2026 QuickBooks Sports Field Fees reconciliation into fin_venue_cost_overrides.
//
// Seven Finance pages read these figures and nothing here is reversible by an undo, so:
//   node scripts/load-field-cost-2026.mjs            dry run, prints what it would write
//   node scripts/load-field-cost-2026.mjs --commit    writes, and only with the snapshot in place
//
// WHY AN OVERRIDE AND NOT A RATE. canonicalVenueCost checks the override first and returns without
// touching per_match_rate or the match count, so a loaded cell is immune to the two-pitch rule and
// to any later change in match volume. That is the point: these are bank figures, not models.
//
// SCOPE IS EXACT. 21 reconciled venues x Jan-Aug, plus the two venues Ryan ruled genuinely free.
// September is excluded everywhere: it holds three days of bank data. Any existing row outside that
// set is untouched.
import fs from "node:fs";
import path from "node:path";

const COMMIT = process.argv.includes("--commit");
const CSV = "scripts/data/field-cost-2026-actuals.csv";
const SNAPSHOT = "fin_venue_cost_overrides_bak_20260916";
const CREATED_BY = "field-cost-2026-reconciliation";

// Ryan's 21 field labels to fin_venues.id. HAND-WRITTEN, NOT NAME-MATCHED. Thirteen of these land
// on a venue whose name is not the label, and a fuzzy match gets several of them wrong: RRMPC has
// no name overlap with "Round Rock" at all, "Lou Indoor" scores equally against Lou Fusz Indoor and
// Lou Fusz Outdoor, and "ATH Katy" / "Soccer Central" each tie against their inactive twin.
// Ryan confirmed venue 4 and venue 19 by hand.
const VENUE_BY_LABEL = {
  "ATH Pearland": 8,
  "Soccer Central": 11,          // not 53, Soccer Central Tournament
  "NEMP": 2,
  "ATH Katy": 7,                 // not 23, ATH Katy Sunday
  "Bicentennial": 13,            // Bicentennial Park, inactive
  "RRMPC": 4,                    // Round Rock. No name overlap; confirmed by hand.
  "Strike": 54,                  // Lowell H. Strike M.S.
  "Hattrick Leander": 3,         // Hattrick. NOT 52, Hattrick T., which is out of scope.
  "KISC": 9,                     // KISC (Katy Intl)
  "Majestic": 15,                // Majestic Gardens, inactive
  "Scissortail": 21,             // Scissortail Park
  "Hammond Park": 17,            // inactive
  "Centennial Commons": 20,      // inactive
  "PRUMC": 16,
  "Stony Point": 6,              // inactive. Not 83, Stony Point High School.
  "Lou Indoor": 19,              // Lou Fusz Indoor, inactive. NOT 18, Lou Fusz Outdoor.
  "Ann Richards": 65,            // Ann Richards School
  "STAR": 12,
  "PAC Global": 10,              // inactive
  "Zipp Family": 64,             // lands on a venue named "New Braunfels". Flagged, not renamed.
  "Galatzan Park": 22,           // inactive
};

// INACTIVE VENUES STILL TAKE THE OVERRIDE. The money cleared the bank in 2026 whatever the row's
// current status says, and eight of the 21 are inactive. Do not skip one, do not flip a status.

// Venues Ryan ruled genuinely free. Eight zeros each, and their per_match_rate is zeroed in the
// same commit so September onward does not quietly start inventing the money again.
// Ryan: "0 all 8 months for billing but we still keep the cost per match."
const FREE_VENUES = { 5: "Onion Creek", 55: "LBJ Early College High School" };
const FREE_REASON = "Free field, no charge. Confirmed by Ryan Sep 2026";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const MONTHS = MON.map((m) => `${m} 2026`);   // "MMM YYYY", verified against the live table

function env() {
  const txt = fs.readFileSync(".env.local", "utf8");
  const out = {};
  for (const line of txt.split("\n")) {
    if (!line.includes("=") || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

// ── THE SOURCE, AND ITS GUARD ───────────────────────────────────────────────────────────────────
// The rounded comparison file sums to a round 170467 and must never load. This is the same check
// the brief specifies, in the loader itself, so the guard travels with the code rather than living
// in a chat: a file without cents refuses to load at all.
const REQUIRED_CENTS = 17046641;

function readActuals() {
  const lines = fs.readFileSync(CSV, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => {
    const [market, field_label, month, amount_usd] = l.split(",");
    return { market, field_label, month, amount: amount_usd?.trim() ? Number(amount_usd) : null };
  });
  const janAug = rows.filter((r) => r.month >= "2026-01" && r.month <= "2026-08");
  const cents = janAug.reduce((a, r) => a + Math.round((r.amount ?? 0) * 100), 0);
  if (cents !== REQUIRED_CENTS) {
    throw new Error(
      `${CSV} sums to ${(cents / 100).toFixed(2)} for Jan-Aug, not ${(REQUIRED_CENTS / 100).toFixed(2)}. ` +
      `A round 170467 means this is the rounded comparison file. Refusing to load.`,
    );
  }
  const unmapped = [...new Set(rows.map((r) => r.field_label))].filter((l) => !(l in VENUE_BY_LABEL));
  if (unmapped.length) throw new Error(`csv labels with no venue in the map: ${unmapped.join(", ")}`);
  return janAug;
}

// ── THE ROWS ────────────────────────────────────────────────────────────────────────────────────
// reason is what the Field Costs panel renders as its formula line, so it is never null.
function buildRows(janAug) {
  const byKey = new Map();
  for (const r of janAug) {
    const id = VENUE_BY_LABEL[r.field_label];
    const month = `${MON[Number(r.month.slice(5, 7)) - 1]} 2026`;
    byKey.set(`${id}|${month}`, r.amount);
  }

  const out = [];
  for (const [label, venue_id] of Object.entries(VENUE_BY_LABEL)) {
    for (const month of MONTHS) {
      const amount = byKey.get(`${venue_id}|${month}`) ?? null;
      out.push({
        venue_id,
        month,
        override_amount: amount ?? 0,
        reason: amount === null
          ? `QuickBooks Sports Field Fees, cash basis: nothing cleared in ${month}`
          : `QuickBooks Sports Field Fees, cash basis, cleared ${month}`,
        created_by: CREATED_BY,
        _label: label,
      });
    }
  }
  for (const [venue_id, name] of Object.entries(FREE_VENUES)) {
    for (const month of MONTHS) {
      out.push({
        venue_id: Number(venue_id),
        month,
        override_amount: 0,
        reason: FREE_REASON,
        created_by: CREATED_BY,
        _label: name,
      });
    }
  }
  // created_at is left to now(), which is when the load ran. The month the money cleared is in
  // `month` already, and conflating the two is how a cash-basis figure loses its date.
  return out;
}

const money = (n) => (Number(n) < 0 ? "-" : "") + "$" +
  Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const E = env();
  const base = E.NEXT_PUBLIC_SUPABASE_URL;
  const H = {
    apikey: E.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + E.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
  };

  const rows = buildRows(readActuals());
  const withMoney = rows.filter((r) => Number(r.override_amount) !== 0);
  const sum = rows.reduce((a, r) => a + Math.round(Number(r.override_amount) * 100), 0);

  console.log(`rows to write        : ${rows.length}  (${Object.keys(VENUE_BY_LABEL).length} reconciled venues x 8 = ${Object.keys(VENUE_BY_LABEL).length * 8}` +
              `, plus ${Object.keys(FREE_VENUES).length} free venues x 8 = ${Object.keys(FREE_VENUES).length * 8})`);
  console.log(`carrying an amount   : ${withMoney.length}   reading zero: ${rows.length - withMoney.length}`);
  console.log(`they sum to          : ${money(sum / 100)}`);
  console.log(`distinct (venue,month): ${new Set(rows.map((r) => `${r.venue_id}|${r.month}`)).size}  (must equal the row count)`);

  // The snapshot is not optional. A load that replaces 22 hand-keyed rows with nothing to restore
  // from is a load that cannot be undone.
  const snap = await fetch(`${base}/rest/v1/${SNAPSHOT}?select=id`,
    { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const haveSnap = snap.status === 200 || snap.status === 206;
  console.log(`snapshot ${SNAPSHOT}: ${haveSnap ? "PRESENT " + snap.headers.get("content-range") : "ABSENT (status " + snap.status + ")"}`);

  // Ten rows chosen for what each one proves, not the first ten off the top: the negative, the two
  // hand-keyed figures this load overrules, a free-venue zero, the largest increase, a cents cell,
  // the venue whose name is not its label, a split-rate twin, an already-zero row, and a plain
  // nothing-cleared month.
  const SHOW = [
    [13, "Jun 2026", "the negative. net refunds, and the one cell that decides 96 rows against 95 and a note"],
    [2,  "Jul 2026", "NEMP July. was $10,000.00 hand-keyed Custom billing month, no bank row behind it"],
    [5,  "May 2026", "Onion Creek. overwrites id 23, $2,040.00 Lump 2025 up to May 21st 2026 Payment"],
    [55, "Jan 2026", "LBJ. genuinely free, so a zero with the free reason rather than a nothing-cleared one"],
    [11, "Jul 2026", "Soccer Central July. the largest increase in the load, +$4,120.00"],
    [4,  "Apr 2026", "RRMPC. cents, and a venue no name match reaches"],
    [64, "Jul 2026", "Zipp Family. lands on a row reading New Braunfels"],
    [7,  "Jan 2026", "ATH Katy. the primary twin, not 23"],
    [20, "May 2026", "Centennial Commons. already $0.00 by hand, reason rewritten to say why"],
    [22, "Jan 2026", "Galatzan Park. a plain month where nothing cleared"],
  ];
  console.log("\n=== TEN REPRESENTATIVE ROWS ===");
  for (const [venue_id, month, why] of SHOW) {
    const r = rows.find((x) => x.venue_id === venue_id && x.month === month);
    if (!r) { console.log(`  MISSING ${venue_id} ${month}  <- ${why}`); continue; }
    console.log(`  venue ${String(r.venue_id).padStart(2)} ${r._label.padEnd(30)} ${r.month}  ${money(r.override_amount).padStart(11)}`);
    console.log(`     reason     : ${r.reason}`);
    console.log(`     created_by : ${r.created_by}        created_at: (left to now())`);
    console.log(`     why shown  : ${why}`);
  }

  if (!COMMIT) {
    console.log("\nDRY RUN. Nothing written. Pass --commit to write.");
    return;
  }
  if (!haveSnap) throw new Error(`refusing to write: the snapshot ${SNAPSHOT} does not exist`);

  const payload = rows.map(({ _label, ...r }) => r);
  const res = await fetch(`${base}/rest/v1/fin_venue_cost_overrides?on_conflict=venue_id,month`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`write failed ${res.status}: ${body.slice(0, 400)}`);
  console.log(`\nWROTE ${JSON.parse(body).length} rows, status ${res.status}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
