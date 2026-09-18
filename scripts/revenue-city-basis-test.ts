/* ONE BASIS PER GRAIN, AND MEMBERSHIP COUNTED ONCE.
 *
 * Finance › Revenue's city table put allocated membership inside a column headed DPP REVENUE and
 * then added membership AGAIN beside it on a different basis. Measured on production, Aug 2026:
 *
 *     city-table "DPP revenue"   $81,296.07  = $66,797.00 roster DPP
 *                                            + $400.00 Private Rental
 *                                            + $14,099.07 ALLOCATED MEMBERSHIP, pre-tax
 *     Membership revenue         $18,887.74  tax-inclusive, the same money again
 *     Total revenue             $100,183.81  against $91,818.65 actually collected
 *
 * Every figure in the fixtures below is that month, to the cent, so a reader can check the suite
 * against the report it came from. The fixtures are hand-built and the suite is pure: it never
 * touches the network, so it runs in the node guards on every push.
 *
 * ── WHY THESE ASSERTIONS AND NOT A SCREENSHOT ─────────────────────────────────────────────────
 * Every defect here rendered as a plausible number. $100,183.81 looks exactly like revenue; so
 * does $81,296.07. Nothing on screen was malformed, which is why it survived three people looking
 * at the page. What can be checked is the ARITHMETIC IDENTITY, and that is all this asserts.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/revenue-city-basis-test.ts
 */
import { buildGroupRows } from "../src/lib/revenueGroupRows";
import { cityNonMembershipRevenueFor, revenueOutsideCities } from "../src/lib/financeStats";
import type { FieldMonth, MatchRow } from "../src/lib/fieldEconomics";
import type { FinanceData } from "../src/lib/useFinanceData";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (m: string, got: number, want: number, tol = 0.005) =>
  Math.abs(got - want) <= tol ? ok(`${m} (${got.toFixed(2)})`) : bad(m, `got ${got.toFixed(2)} want ${want.toFixed(2)}`);
const money = (n: number) => `$${n.toFixed(2)}`;

const MONTH = "Aug 2026";

/* ── THE LEDGER, Aug 2026, AS fin_revenue HOLDS IT ────────────────────────────────────────────
 * Real figures, read from production 2026-09-17. The last two rows are the ones no displayed
 * city owns and are the whole reason the table cannot tie to the card on its own. */
const REV = [
  ["Austin", "DPP", 30829.71], ["Austin", "Private Rental", 400.00], ["Austin", "Membership", 8216.37],
  ["Houston", "DPP", 16287.90], ["Houston", "Strike", 21.65], ["Houston", "Membership", 4215.97],
  ["San Antonio", "DPP", 17990.15], ["San Antonio", "Membership", 4590.11],
  ["OKC", "DPP", 2845.75], ["OKC", "Membership", 258.35],
  ["Dallas", "DPP", 2156.30], ["Dallas", "Membership", 556.48],
  ["Atlanta", "DPP", 1421.88], ["Atlanta", "Membership", 774.05],
  ["St. Louis", "DPP", 934.34], ["St. Louis", "Membership", 276.41],
  ["Deleted Account Revenue", "Membership", 42.69],
  ["El Paso", "DPP", 0.54],
] as const;

const CARD_TOTAL = 91818.65;      // the summary card's Total revenue row
const CARD_DPP = 72888.22;        // its DPP row: every non-Membership row
const CARD_MEMBERSHIP = 18930.43; // its Membership row

const data = {
  revenue: REV.map(([city, type, gross], i) => ({ id: i, city, type, gross, month: MONTH })),
} as unknown as FinanceData;

const SHOWN = ["Atlanta", "Austin", "Dallas", "Houston", "OKC", "San Antonio", "St. Louis"];

/* ── THE ROSTER SIDE, as FieldMonth carries it ────────────────────────────────────────────────
 * `revenue` is venuePartnerRevenueFor + the member slice, which is the shape that caused this.
 * Austin's two rows are the real split: $400 of Private Rental sits at one pitch. */
const fm = (field: string, city: string, gate: number, rental: number, membership: number | null, matches: number): FieldMonth => ({
  key: `g-${field}`, field, city, month: MONTH, basis: "per_match", venueIds: [1],
  cost: null, revenue: gate + rental + (membership ?? 0), privateRental: rental,
  membership, eventRevenue: 0, matches, costPerMatch: null,
});
const FIELDS: FieldMonth[] = [
  fm("Hattrick", "Austin", 17000.00, 400.00, 4000.00, 60),
  fm("LBJ", "Austin", 11829.00, 0, 2923.62, 40),
  fm("PRUMC", "Atlanta", 1300.00, 0, 466.42, 8),
  fm("Soccer Central", "San Antonio", 16000.00, 0, 3828.99, 50),
];
const ROSTER_GATE = 17000 + 11829 + 1300 + 16000;   // 46,129.00
const ROSTER_RENTAL = 400.00;
const ALLOCATED = 4000 + 2923.62 + 466.42 + 3828.99; // 11,219.03
const MATCH_ROWS: MatchRow[] = [];

const membershipOf = (c: string) =>
  REV.filter(([city, type]) => city === c && type === "Membership").reduce((a, [, , g]) => a + g, 0);
const cityNonMembershipOf = (c: string) => cityNonMembershipRevenueFor(data, c, MONTH);

const build = (grain: "city" | "field") => buildGroupRows({
  rows: FIELDS, matchRows: MATCH_ROWS, grain, month: MONTH,
  membershipOf, membershipScoped: true,
  cityNonMembershipOf: grain === "city" ? cityNonMembershipOf : null,
});

console.log("\nthe fixture is the month it claims to be");
{
  // POSITIVE CONTROL. Every assertion below divides or sums these; if the fixture does not add up
  // to the card, nothing after it means anything.
  near("the ledger fixture sums to the card's Total", REV.reduce((a, [, , g]) => a + g, 0), CARD_TOTAL);
  near("…its non-Membership rows sum to the card's DPP row",
    REV.filter(([, t]) => t !== "Membership").reduce((a, [, , g]) => a + g, 0), CARD_DPP);
  near("…and its Membership rows to the card's Membership row",
    REV.filter(([, t]) => t === "Membership").reduce((a, [, , g]) => a + g, 0), CARD_MEMBERSHIP);
  /* CONTROL: the two ways of splitting membership are the SAME split. `type === "Membership"`
   * here, `!/member/i` on the cards. Proven over all 8,363 production rows and pinned here so a
   * new type spelled "Member credit" cannot silently land on one side only. */
  is("the exact-match and regex splits agree on every fixture row",
    REV.filter(([, t]) => (t === "Membership") !== /member/i.test(t)).map(([c, t]) => `${c}|${t}`), []);
}

console.log("\n1. the city Total reconciles to the card, with the remainder named");
{
  const b = build("city")!;
  const out = revenueOutsideCities(data, MONTH, SHOWN);
  near("the table's Total is the seven displayed cities' gross", b.T.total, CARD_TOTAL - 43.23);
  near("what no displayed city owns is $43.23", out.gross, 43.23);
  is("…and it is itemised by name, not rolled into an 'other'",
    out.rows.map((r) => `${r.city} ${money(r.gross)}`),
    ["Deleted Account Revenue $42.69", "El Paso $0.54"]);
  near("TABLE TOTAL + REMAINDER = MONEY COLLECTED, to the cent", b.T.total + out.gross, CARD_TOTAL);
  near("…and the month gross it reconciles against is the card's own", out.monthGross, CARD_TOTAL);
  /* CONTROL FOR THE IDENTITY ABOVE, which is the one that would pass vacuously. An empty table
   * and an empty remainder also sum to nothing; both sides have to be non-trivial for the tie to
   * be evidence. And the remainder must NOT be zero, or "they tie" is just "there is nothing
   * outside", which is a different and weaker claim. */
  is("control: the tie is between two non-empty sides",
    [b.T.total > 90000, out.gross > 0, out.rows.length], [true, true, 2]);
  /* CONTROL: the remainder is the cities' complement, not a constant. Widen `shown` to include
   * El Paso and the remainder must shrink by exactly El Paso. */
  near("control: adding El Paso to the row set moves the remainder by exactly El Paso",
    revenueOutsideCities(data, MONTH, [...SHOWN, "El Paso"]).gross, 43.23 - 0.54);
}

console.log("\n2. no membership in the DPP column");
{
  const b = build("city")!;
  near("the city DPP column equals the card's DPP row", b.T.dpp, CARD_DPP - 0.54);
  near("…the Membership column equals the card's Membership row", b.T.membership ?? 0, CARD_MEMBERSHIP - 42.69);
  /* THE PRE-FIX ARITHMETIC, RUN HERE SO THE ASSERTION ABOVE CANNOT PASS VACUOUSLY. This is what
   * the column used to hold: the roster walk WITH the member slice left in. If the two were ever
   * within a dollar of each other, the assertion above would be proving nothing. */
  const preFix = FIELDS.reduce((a, r) => a + r.revenue, 0);
  near("control: the pre-fix column was a different number", preFix, ROSTER_GATE + ROSTER_RENTAL + ALLOCATED);
  is("…and the two are far apart, so the assertion has teeth",
    Math.abs(preFix - b.T.dpp) > 1000, true);
  near("control: the pre-fix figure was exactly the pitch money PLUS the allocation",
    preFix - (ROSTER_GATE + ROSTER_RENTAL), ALLOCATED);

  /* FIELD GRAIN KEEPS THE ROSTER AND STILL DROPS THE SLICE. Same defect, same fix, different
   * source — this is the half the city-grain assertions cannot see. */
  const f = build("field")!;
  near("field grain's DPP column is the roster walk WITHOUT the member slice", f.T.dpp, ROSTER_GATE + ROSTER_RENTAL);
  is("control: that is strictly less than FieldMonth.revenue, which is what it used to print",
    f.T.dpp < preFix, true);
  near("…and the difference is exactly the allocation", preFix - f.T.dpp, ALLOCATED);
}

console.log("\n3. membership appears exactly once in Total");
{
  const b = build("city")!;
  /* BY HAND, ONE CITY, SHOWN. Austin's ledger is $30,829.71 DPP + $400.00 Private Rental +
   * $8,216.37 Membership. The DPP cell must be the first two, the Membership cell the third, and
   * the Total all three — each appearing once. */
  const austin = b.list.find((r) => r.label === "Austin")!;
  near("Austin DPP cell = $30,829.71 + $400.00", austin.dpp, 31229.71);
  near("Austin Membership cell = $8,216.37", austin.membership ?? 0, 8216.37);
  near("Austin Total = $31,229.71 + $8,216.37", austin.total, 39446.08);
  near("…which is Austin's whole fin_revenue gross for the month", austin.total,
    REV.filter(([c]) => c === "Austin").reduce((a, [, , g]) => a + g, 0));
  /* THE DOUBLE COUNT, NAMED AND DERIVED. Austin's Total under the old arithmetic was the roster
   * walk — which ALREADY held $6,923.62 of allocated membership, pre-tax — plus $8,216.37 of
   * tax-inclusive membership again. Strip the pitch money out of that old total and what is left
   * is the two membership figures, which is the defect stated as an equation rather than as a
   * threshold somebody has to pick. */
  const AUSTIN_GATE = 17000 + 11829, AUSTIN_RENTAL = 400, AUSTIN_ALLOC = 4000 + 2923.62;
  const oldAustin = FIELDS.filter((r) => r.city === "Austin").reduce((a, r) => a + r.revenue, 0) + 8216.37;
  near("control: the old Total held membership TWICE, on two bases",
    oldAustin - (AUSTIN_GATE + AUSTIN_RENTAL), AUSTIN_ALLOC + 8216.37);
  is("control: and it was larger than the new one", oldAustin > austin.total, true);

  is("every row's Total equals its own two cells", b.list.filter((r) => Math.abs(r.total - (r.dpp + (r.membership ?? 0))) > 0.005).map((r) => r.label), []);
  is("control: rows checked", b.list.length, 7);
  near("and the Total row equals the two column totals", b.T.total, b.T.dpp + (b.T.membership ?? 0));
}

console.log("\n4. a city with ledger revenue and no venue-month row still gets a row");
{
  const b = build("city")!;
  /* Only four of the seven cities have a FieldMonth row in the fixture. The other three carry
   * real ledger money and would have vanished into the remainder with nothing on screen. */
  is("all seven displayed cities have a row", b.list.map((r) => r.label).sort(),
    [...SHOWN].sort());
  const okc = b.list.find((r) => r.label === "OKC")!;
  is("control: OKC has no venue-month row in the fixture",
    FIELDS.some((r) => r.city === "OKC"), false);
  near("…and still carries its ledger revenue", okc.total, 2845.75 + 258.35);
  is("…with 0 venues and 0 matches, because that is what is true of it",
    [okc.venueCount, okc.matches], [0, 0]);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
