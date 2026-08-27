import "server-only"; // no-op under --conditions=react-server
// CHURN — the window, the tiers, the threshold, and the tile that did nothing.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/churn-test.ts
//
// FOUR DEFECTS, AND ONE OF THEM IS A PARSER RULE:
//
//   · The window defaulted to ALL TIME, so 9,427 people — a third of everyone who ever registered
//     — arrived as one list, and a player last seen in September 2024 sat beside one who lapsed in
//     May. Measured at the 90-day floor: all time 9,427 · 12 months 4,719 · THIS YEAR 3,166.
//   · The "10+ prior matches" tile said "click to show only these" AND CLICKING DID NOTHING. It was
//     a <button> containing a <button>. The HTML parser silently unnests that: the inner control
//     escapes the tile and the outer one stops being the control it looks like. Nothing errors,
//     nothing warns, and the tile is dead. THE TILE MUST BE A DIV with role="button".
//   · 10 was a constant compiled into the page. It is a stepper now, and the middle tier's label is
//     DERIVED from it — so this suite asserts the RELATIONSHIP and never the number 10.
//   · Rows showed a bare Player ID. A churn list you cannot contact is a report, not a task.

import {
  WINDOWS, DEFAULT_WINDOW, DEFAULT_HEAVY, HEAVY_MIN, HEAVY_MAX, REGULAR_FLOOR, TIERS, TIER_NAME,
  windowStart, effectiveStart, clampHeavy, tierOf, tierDefinition, tierBounds, toggleTier,
  applyFilter, tierCounts, totalSpent, memberCount, daysGone, isStale, DAYS_RED,
  emailDisplay, contactRoute, spentFromEv, isScrubbed, dropsOnNarrow, NARROW_KEEP, NARROW_DROP,
  type ChurnRow, type Tier,
} from "../src/lib/churnModel";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("CHURN\n");

const TODAY = "2026-08-27";
let uid = 0;
const row = (last: string, matches: number, over: Partial<ChurnRow> = {}): ChurnRow => ({
  id: ++uid, name: `Player ${uid}`, email: `p${uid}@example.com`, phone: `+1512555${String(uid).padStart(4, "0")}`,
  city: "Austin", field: "PARMER", matches, spent: matches * 13.5, last, days: daysGone(last, TODAY),
  isMember: false, ...over,
});
/* THE FIXTURE CARRIES THE PLAYER THE BUG WAS ABOUT: last played September 2024, 704 days gone.
 * The 90-day floor cannot exclude him — only the window can, which is the whole point. */
const ANCIENT = row("2024-09-22", 14);
const ROWS: ChurnRow[] = [
  ANCIENT,
  row("2025-03-04", 22), row("2025-11-30", 4),
  row("2026-01-14", 11), row("2026-02-02", 3), row("2026-03-19", 1),
  row("2026-04-08", 9), row("2026-05-21", 2),
  /* THE MEMBER MUST CLEAR THE FLOOR. First written as 2026-05-30, which is 89 days before TODAY —
   * one day under the 90-day floor — so the row the whole "still paying, stopped playing" rule is
   * about was filtered out and the assertion read false. */
  row("2026-04-30", 40, { isMember: true }),
  row("2026-08-20", 12), // inside the window but only 7 days gone — the FLOOR must drop this one
  row("2026-06-01", 1, { email: "a1b2c3@privaterelay.appleid.com" }),
  row("2026-06-11", 5, { phone: null }),
  row("2026-06-21", 2, { email: null }),
  row("2026-07-01", 3, { email: null, phone: null }),
];
const F = (over: Partial<Parameters<typeof applyFilter>[1]> = {}) =>
  applyFilter(ROWS, { start: windowStart(DEFAULT_WINDOW, TODAY), floorDays: 90, tier: null, heavy: DEFAULT_HEAVY, ...over });

// ── 1. THE DEFAULT WINDOW FILTERS, AND ALL TIME WIDENS IT ────────────────────────────────────
console.log("the window: this year by default, and All time brings the earlier years back");
{
  is("the default is this year", DEFAULT_WINDOW, "ytd");
  is("this year starts on 1 January", windowStart("ytd", TODAY), "2026-01-01");
  is("12 months is a year back to the day", windowStart("12m", TODAY), "2025-08-27");
  is("all time is earlier than any match", windowStart("all", TODAY) < "2023-04-10", true);
  is("three windows are offered", WINDOWS.map((w) => w.kind), ["ytd", "12m", "all"]);

  const def = F();
  /* EVERY LISTED PLAYER'S LAST-PLAYED FALLS INSIDE THE WINDOW. This is the assertion the page
   * needed and did not have — the 704-day player passed the floor and nothing else looked at him. */
  const start = windowStart("ytd", TODAY);
  if (def.every((r) => r.last >= start)) ok(`all ${def.length} listed players last played on or after ${start}`);
  else bad("every listed player is inside the window", JSON.stringify(def.filter((r) => r.last < start).map((r) => r.last)));
  is("the September 2024 player is NOT in the default list", def.some((r) => r.id === ANCIENT.id), false);
  is("…and he is 704 days gone, so the floor could never have excluded him", ANCIENT.days, 704);
  is("control — the floor would happily keep him", ANCIENT.days >= 90, true);

  const all = F({ start: windowStart("all", TODAY) });
  is("All time brings him back", all.some((r) => r.id === ANCIENT.id), true);
  is("…and All time is strictly wider", all.length > def.length, true);
  const y12 = F({ start: windowStart("12m", TODAY) });
  is("12 months sits between them", y12.length >= def.length && y12.length <= all.length, true);
  is("…and is strictly wider than this year here", y12.length > def.length, true);

  // THE DATE BOX OVERRIDES THE BUTTONS. One bound in force at a time.
  is("a typed date wins over the buttons", effectiveStart("all", "2026-05-01", TODAY), "2026-05-01");
  is("an empty box leaves the buttons in charge", effectiveStart("12m", "", TODAY), "2025-08-27");
  is("whitespace is not a date", effectiveStart("ytd", "   ", TODAY), "2026-01-01");
}

// ── 2. "NOT PLAYED FOR" IS A FLOOR ───────────────────────────────────────────────────────────
console.log("\nthe floor: no row below it, ever");
{
  for (const floor of [30, 60, 90, 120]) {
    const got = F({ floorDays: floor, start: windowStart("all", TODAY) });
    const under = got.filter((r) => r.days < floor);
    if (!under.length) ok(`floor ${floor}: no row below it (${got.length} rows)`);
    else bad(`floor ${floor}: no row below it`, JSON.stringify(under.map((r) => r.days)));
  }
  // POSITIVE CONTROL: the fixture DOES hold a row the floor must drop, or these zeros prove nothing.
  const recent = ROWS.filter((r) => r.days < 90);
  is("control — the fixture holds a player too recent to qualify", recent.length > 0, true);
  is("…and he is filtered out", F().some((r) => r.id === recent[0].id), false);
  is("raising the floor can only shrink the list",
     F({ floorDays: 120, start: windowStart("all", TODAY) }).length <= F({ floorDays: 30, start: windowStart("all", TODAY) }).length, true);
}

// ── 3. THE TILES FILTER, AND CLICKING AGAIN CLEARS ───────────────────────────────────────────
console.log("\nthe tiles: they filter, they clear, and each holds its own bound");
{
  const base = F();
  const counts = tierCounts(base, DEFAULT_HEAVY);
  is("the three counts add up to the whole list", counts.heavy + counts.regular + counts.tried, base.length);
  for (const t of TIERS) {
    const got = F({ tier: t });
    is(`${TIER_NAME[t]} filters to its own count`, got.length, counts[t]);
    /* THE TIER REALLY HOLDS ITS BOUND — not just "a smaller list". A filter that returned a
     * plausible subset of the wrong rows would pass a count check and fail a person. */
    const { min, max } = tierBounds(t, DEFAULT_HEAVY);
    const outside = got.filter((r) => r.matches < min || r.matches > max);
    if (!outside.length) ok(`  …and every row is between ${min} and ${max === Infinity ? "∞" : max} matches`);
    else bad(`  ${t} holds its bound`, JSON.stringify(outside.map((r) => r.matches)));
    is(`  …and it is strictly smaller than the unfiltered list`, got.length < base.length, true);
  }
  // CLICKING AGAIN CLEARS. A filter you cannot undo from the control that set it is a trap.
  is("clicking a tile selects it", toggleTier(null, "heavy"), "heavy");
  is("clicking the same tile again clears it", toggleTier("heavy", "heavy"), null);
  is("clicking a different tile switches", toggleTier("heavy", "tried"), "tried");
  is("clearing restores the whole list", F({ tier: toggleTier("heavy", "heavy") }).length, base.length);
  // The tiers partition: no row belongs to two.
  for (const r of base) {
    const hits = TIERS.filter((t) => { const b = tierBounds(t, DEFAULT_HEAVY); return r.matches >= b.min && r.matches <= b.max; });
    if (hits.length !== 1) { bad("every row belongs to exactly one tier", `${r.matches} matches → ${JSON.stringify(hits)}`); break; }
  }
  ok("every row belongs to exactly one tier");
  is("labels are the fact, not advice", TIERS.map((t) => TIER_NAME[t]), ["Heavy", "Regular", "Tried it"]);
  /* READ THE CODE, NOT THE PROSE. This file's own header QUOTES the dead copy to explain what it
   * was, and the first version of this check went red on that comment — the same false positive the
   * auth census fixed. Comments are stripped before deciding what the panel RENDERS. */
  const panelRaw = readFileSync("src/components/growth/ChurnPanel.tsx", "utf8");
  const panel = panelRaw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  for (const advice of ["worth a phone call", "click to show only these", "Worth a phone call"])
    if (!panel.includes(advice)) ok(`"${advice}" is gone from the rendered copy`); else bad(`"${advice}" is gone`, "still rendered");
  is("control — the pattern finds that copy when it IS present", "x click to show only these y".includes("click to show only these"), true);
}

// ── 4. THE THRESHOLD IS A CONTROL — THE RELATIONSHIP, NOT THE NUMBER ─────────────────────────
console.log("\nthe threshold: raising it lowers Heavy and relabels the middle tile");
{
  const base = F({ start: windowStart("all", TODAY) });
  let prevHeavy = Infinity;
  for (const h of [4, 6, 10, 14, 20, 30]) {
    const c = tierCounts(base, h);
    if (c.heavy <= prevHeavy) ok(`threshold ${h}: Heavy is ${c.heavy}, no higher than at the lower threshold`);
    else bad(`threshold ${h}: raising it cannot raise Heavy`, `${prevHeavy} → ${c.heavy}`);
    /* THE MIDDLE TILE IS RELABELLED FROM THE SAME NUMBER THE FILTER USES. This is the assertion —
     * not "it says 3 to 9". The label and the bound are read from one source. */
    const label = tierDefinition("regular", h);
    const b = tierBounds("regular", h);
    const want = b.min === b.max ? `${b.min} matches` : `${b.min} to ${b.max} matches`;
    is(`  …and the middle tile reads "${want}"`, label, want);
    is(`  …matching the bound it actually filters on`, [b.min, b.max], [REGULAR_FLOOR, h - 1]);
    prevHeavy = c.heavy;
  }
  // POSITIVE CONTROL: somewhere in that sweep the count must actually MOVE, or "no higher" is vacuous.
  is("control — Heavy genuinely changes across the sweep",
     tierCounts(base, 4).heavy > tierCounts(base, 30).heavy, true);
  is("the Heavy tile states the threshold", tierDefinition("heavy", 14), "14+ matches");
  is("the bottom tile never moves — it is the definition of trying it once", tierDefinition("tried", 14), tierDefinition("tried", 4));
  // THE STEPPER CANNOT PRODUCE AN EMPTY MIDDLE TIER.
  is("it cannot go below its floor", clampHeavy(HEAVY_MIN - 5), HEAVY_MIN);
  is("…which still leaves the middle tier one value", tierBounds("regular", HEAVY_MIN).min <= tierBounds("regular", HEAVY_MIN).max, true);
  is("it cannot go above its ceiling", clampHeavy(HEAVY_MAX + 99), HEAVY_MAX);
  is("garbage falls back to the default", clampHeavy(NaN), DEFAULT_HEAVY);
  is("a tier is decided by the SAME threshold the label used", tierOf(9, 10), "regular");
  is("…and moves when the threshold does", tierOf(9, 6), "heavy");
}

// ── 5. THE NESTED-BUTTON BUG ─────────────────────────────────────────────────────────────────
console.log("\nthe tile is a div, and the stepper is inside it");
{
  const panel = readFileSync("src/components/growth/ChurnPanel.tsx", "utf8");
  const jsx = panel.slice(panel.indexOf("return ("), panel.indexOf("const CHURN_CSS"));
  /* A <button> MAY NOT CONTAIN A <button>. The parser unnests it silently — no error, no warning —
   * so the stepper escapes the tile and the tile stops being the control it looks like. That is
   * exactly why "click to show only these" did nothing. */
  const tileBlock = jsx.slice(jsx.indexOf('data-testid="churn-tiles"'), jsx.indexOf('data-testid="churn-count"'));
  if (/role="button"/.test(tileBlock)) ok("the tile is a div with role=button"); else bad("the tile is a div with role=button");
  if (/tabIndex=\{0\}/.test(tileBlock)) ok("…reachable by keyboard"); else bad("…reachable by keyboard");
  if (/onKeyDown=\{\(e\) => tileKey\(e, t\)\}/.test(tileBlock)) ok("…and Enter/Space activate it"); else bad("…Enter/Space activate it");
  if (/e\.key === "Enter" \|\| e\.key === " "/.test(panel)) ok("…both keys, as a real button has"); else bad("…both keys");
  // The tile must NOT be a <button>, or the stepper inside it is unnested by the parser.
  const tileOpen = tileBlock.match(/<(\w+)[^>]*className=\{`tile/);
  is("the tile element is a div, not a button", tileOpen?.[1], "div");
  /* THE STEPPER IS STILL INSIDE ITS TILE. Asserted structurally: the stepper's markup must appear
   * between the tile's opening tag and its closing one. */
  const stepIdx = tileBlock.indexOf('data-testid="churn-stepper"');
  const tileIdx = tileBlock.indexOf('data-testid={`churn-tile-');
  const closeIdx = tileBlock.lastIndexOf("</div>");
  if (stepIdx > tileIdx && stepIdx < closeIdx) ok("the stepper markup sits inside the tile, not after it");
  else bad("the stepper sits inside the tile", `tile@${tileIdx} step@${stepIdx} close@${closeIdx}`);
  if (/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(tileBlock)) ok("…and pressing it does not also toggle the tier");
  else bad("…pressing it does not also toggle the tier", "the stepper would filter the table every click");
  for (const t of ["churn-step-up", "churn-step-down", "churn-threshold"])
    if (panel.includes(`data-testid="${t}"`)) ok(`${t} is on the page`); else bad(`${t} is on the page`);
  // Every tile carries its definition.
  if (/data-testid=\{`churn-def-\$\{t\}`\}/.test(tileBlock)) ok("every tile states its own definition underneath");
  else bad("every tile states its own definition");
}

// ── 6. EVERY ROW IS CONTACTABLE, OR SAYS WHY NOT ─────────────────────────────────────────────
console.log("\ncontact: a phone, and an email or a stated reason there is none");
{
  const list = F({ start: windowStart("all", TODAY) });
  for (const r of list) {
    const e = emailDisplay(r), c = contactRoute(r);
    const hasPhone = !!r.phone;
    const hasReason = !hasPhone ? /no phone/i.test(c.how) : true;
    const emailOk = e.kind === "address" || /relay|No email/i.test(e.text);
    if (hasReason && emailOk) continue;
    bad("every row has a phone, or an email, or a stated reason", JSON.stringify({ id: r.id, phone: r.phone, email: r.email, how: c.how }));
  }
  ok(`all ${list.length} rows carry a phone, an email, or a stated reason they have neither`);
  is("a relay address is LABELLED, never printed", emailDisplay({ email: "a1b2c3@privaterelay.appleid.com" }), { text: "Apple private relay", kind: "relay" });
  is("…so no token reaches the column", /privaterelay/i.test(emailDisplay({ email: "x@privaterelay.appleid.com" }).text), false);
  is("control — the pattern finds the token in the raw address", /privaterelay/i.test("x@privaterelay.appleid.com"), true);
  is("a real address renders as itself", emailDisplay({ email: "a@b.com" }), { text: "a@b.com", kind: "address" });
  is("a missing address says so", emailDisplay({ email: null }), { text: "No email on file", kind: "none" });
  is("a relay person is still reachable — by phone", contactRoute({ email: "x@privaterelay.appleid.com", phone: "+15125550000" }).reachable, true);
  is("…and the route names the reason", contactRoute({ email: "x@privaterelay.appleid.com", phone: "+15125550000" }).how, "phone — the address is an Apple relay");
  is("no phone and a relay address is UNREACHABLE, and says so", contactRoute({ email: "x@privaterelay.appleid.com", phone: null }).reachable, false);
  is("no phone and no email is unreachable", contactRoute({ email: null, phone: null }).reachable, false);
  is("…with a reason, not a blank", contactRoute({ email: null, phone: null }).how.length > 10, true);
  is("email only is still reachable", contactRoute({ email: "a@b.com", phone: null }).reachable, true);
  // MEMBERS — the most urgent rows on the page.
  is("a still-paying member is counted", memberCount(list) > 0, true);
  const panel = readFileSync("src/components/growth/ChurnPanel.tsx", "utf8");
  if (/data-testid="churn-member"/.test(panel)) ok("…and flagged on the row"); else bad("…and flagged on the row");
  if (/data-testid="churn-members"/.test(panel)) ok("…and counted in the header"); else bad("…and counted in the header");
  if (!/data-testid="churn-row"[\s\S]{0,200}\{p\.u\}<\/td>/.test(panel)) ok("a bare Player ID is no longer the first column");
  else bad("a bare Player ID is no longer the first column");
}

// ── 7. DAYS IN RED, AND THE FOOTER'S DOLLARS ─────────────────────────────────────────────────
console.log("\nred past 270 days, and a total in dollars");
{
  is("the threshold is 270 days", DAYS_RED, 270);
  is("270 exactly is not yet red", isStale(270), false);
  is("271 is", isStale(271), true);
  is("a fresh lapse is not", isStale(95), false);
  const list = F({ start: windowStart("all", TODAY) });
  is("control — the fixture has both red and not-red rows",
     list.some((r) => isStale(r.days)) && list.some((r) => !isStale(r.days)), true);
  is("the footer totals what they spent", totalSpent(list), Math.round(list.reduce((a, r) => a + r.spent, 0) * 100) / 100);
  is("…and it is a real figure, not zero", totalSpent(list) > 0, true);
  is("an empty list totals zero rather than NaN", totalSpent([]), 0);
  // `ev` is a list of events, not a number.
  is("spend is parsed out of ev", spentFromEv(["2024-01|ATX|PARMER|13", "2024-02|ATX|PARMER|10.5"]), 23.5);
  is("a missing ev is zero, not absent", spentFromEv(null), 0);
  is("a malformed entry does not poison the sum", spentFromEv(["2024-01|ATX|PARMER|x", "2024-02|ATX|PARMER|10"]), 10);
}

// ── 8. NARROW SCREENS ────────────────────────────────────────────────────────────────────────
console.log("\nnarrow: Field, Spent and Last played go; the phone never does");
{
  is("three columns drop", [...NARROW_DROP], ["field", "spent", "last"]);
  for (const c of NARROW_DROP) is(`${c} drops`, dropsOnNarrow(c), true);
  for (const c of NARROW_KEEP) is(`${c} stays`, dropsOnNarrow(c), false);
  is("the phone is in the keep list — it is the only route to a relay address", NARROW_KEEP.includes("phone" as never), true);
  const panel = readFileSync("src/components/growth/ChurnPanel.tsx", "utf8");
  const media = panel.slice(panel.indexOf("@media (max-width:760px)"));
  if (/\.drop\{display:none\}/.test(media)) ok("the drop class is hidden under 760px"); else bad("the drop class is hidden under 760px");
  /* NOTHING OVERFLOWS ITS CELL. Asserted on the STYLES that make overflow impossible rather than on
   * scrollWidth — an overflowing child does not raise its parent's scrollWidth when overflow is
   * visible, so that measurement misses exactly the case it is meant to catch. */
  if (/overflow-wrap:anywhere/.test(panel)) ok("long names and addresses wrap rather than overflow");
  else bad("long names and addresses wrap", "a long email would run out of its cell");
  if (/\.mcChurn \.tblwrap\{overflow-x:auto/.test(panel)) ok("the table scrolls inside its own container, not the page");
  else bad("the table scrolls inside its own container");
  if (/white-space:nowrap/.test(panel)) ok("numeric columns do not wrap mid-figure"); else bad("numeric columns do not wrap");
  const dropCells = (panel.match(/className="[^"]*\bdrop\b/g) ?? []).length;
  if (dropCells >= 8) ok(`${dropCells} header and body cells carry the drop class — head and body stay aligned`);
  else bad("head and body both carry the drop class", `only ${dropCells}`);
}

// ── 9. TWO BUGS THE BROWSER FOUND, PINNED ────────────────────────────────────────────────────
console.log("\nthe paged range, and the deleted accounts");
{
  const views = readFileSync("src/lib/growthViews.ts", "utf8");
  const churn = views.slice(views.indexOf("export async function fetchChurnList"));
  /* .order() IS NOT OPTIONAL ON A PAGED RANGE. selectAllRange walks .range(0,999), .range(1000,
   * 1999)… over a 14,751-row VIEW; with no ORDER BY the server may return rows in any order, so
   * consecutive pages OVERLAP AND SKIP. On screen: the same player three times ("Hash", 361
   * matches) where the source holds exactly one such row. Same trap the facts doc records about
   * /admin/promocodes — here, in our own database. */
  if (/\.order\("user_id", \{ ascending: true \}\)\.range\(from, to\)/.test(churn))
    ok("the churn page range is ORDERED, so pages cannot overlap or skip");
  else bad("the churn page range is ordered", "DUPLICATES AND OMISSIONS ARE BACK");
  if (/seen\.has\(r\.user_id\)/.test(churn)) ok("…and a duplicate user_id is dropped even so");
  else bad("…a duplicate user_id is dropped even so");

  is("a scrubbed address is recognised", isScrubbed("del_bb4827b0834808d5807873ea65296ffd@playmatchday.com"), true);
  is("a real address is not", isScrubbed("someone@playmatchday.com"), false);
  is("…nor an ordinary one", isScrubbed("a@b.com"), false);
  is("…nor an empty one", isScrubbed(null), false);
  if (/const contactable = visible\.filter\(\(r\) => !isScrubbed\(r\.email\)\)/.test(churn))
    ok("deleted accounts are off a list whose purpose is contacting people");
  else bad("deleted accounts are off the list");
  const panelSrc = readFileSync("src/components/growth/ChurnPanel.tsx", "utf8");
  if (/data-testid="churn-scrubbed"/.test(panelSrc)) ok("…and the count says how many, rather than quietly shrinking");
  else bad("…and the count says how many");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
