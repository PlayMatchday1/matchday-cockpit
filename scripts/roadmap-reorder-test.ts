/* TECH ROADMAP — ORDER INSIDE A COLUMN.
 *
 * WHAT THIS GUARDS. Reordering a card inside a column must write sort_order and
 * NOTHING ELSE. If it ever touches stage_entered_at, then "sitting too long",
 * "longest untouched" and every age on the board are reset by an act that
 * changed nothing about the work — the counters would lie, silently, and the
 * board's only job is those counters. Moving BETWEEN columns must keep
 * resetting it. Both directions are asserted here.
 *
 * It also pins the two things that make an order worth having: it is TOTAL
 * (sort_order, then created_at, then id — so it cannot reshuffle between two
 * loads), and a reorder writes ONE row rather than renumbering the column.
 *
 * NOT WIRED INTO `npm run verify`. Per CLAUDE.md's bar, the mandatory node
 * guards are the ones standing between a change and a player's money or match
 * record; the Tech Roadmap is an internal board and a wrong order on it is
 * visible to Ryan the moment he looks. This runs on demand:
 *
 *     npx tsx scripts/roadmap-reorder-test.ts
 */
import {
  columnCards, planMove, planReorder, stepTarget, roadmapBoardOf,
} from "../src/lib/roadmap";
import { compareBoardOrder, sortOrderForDrop } from "../src/lib/kanban";
import type { KanbanCard } from "../src/lib/kanban";
import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* EVERY FILTERED ASSERTION GOES THROUGH THIS FIRST. A .filter().map() compared
 * against [] is green when the collection is empty — when the fixture is wrong,
 * when a field is undefined, when nothing was built at all. Same contract as
 * nonEmpty() in scripts/e2e/_session.mjs; a local copy because this suite does
 * not load the browser session module. */
function nonEmpty<T>(coll: T[], label: string): T[] {
  if (!Array.isArray(coll)) throw new Error(`nonEmpty(${label}): not an array — got ${typeof coll}`);
  if (coll.length === 0) {
    throw new Error(
      `EMPTY COLLECTION: expected at least one ${label}, found none. An assertion over an ` +
      `empty set passes without testing anything, so this fails instead.`,
    );
  }
  return coll;
}

/* ── fixture ───────────────────────────────────────────────────────────────
 * Shaped from the REAL app/ideas column (probed 2026-09-03, 40 tech_roadmap
 * rows): integer sort_orders with earlier midpoint writes already among them,
 * and — from the Clubhouse seed insert of migration 0090 — two rows sharing a
 * created_at to the microsecond, which is why id is the last tiebreak. */
const T0 = "2026-08-01T22:20:40.000Z";
function card(id: string, sort_order: number, stage = "ideas", created_at = T0, board: "app" | "clubhouse" = "app"): KanbanCard {
  return {
    id, board_type: "tech_roadmap", board, title: `card ${id}`, stage,
    owner_user_id: null, sort_order, data: {},
    created_at, updated_at: created_at, stage_entered_at: "2026-07-01T00:00:00.000Z",
  };
}
// A..E in app/ideas, plus decoys the column must exclude.
const FIXTURE: KanbanCard[] = [
  card("A", 6), card("B", 7), card("C", 7.5), card("D", 10), card("E", 12),
  card("X", 1, "in_plan"),                     // same board, different column
  card("Y", 1, "ideas", T0, "clubhouse"),      // same column name, other board
];
const ids = (l: KanbanCard[]) => l.map((c) => c.id);
const COL = () => columnCards(FIXTURE, "app", "ideas");

/* Apply a plan the way the view does — one PostgREST PATCH against one id. */
function applyPatch(cards: KanbanCard[], id: string, patch: Record<string, unknown>): KanbanCard[] {
  return cards.map((c) => (c.id === id ? { ...c, ...patch } : c));
}
/* Which rows a patch actually altered. This is how "writes exactly one row" is
 * measured: by diffing every field of every card, not by trusting the caller. */
function changedRows(before: KanbanCard[], after: KanbanCard[]): string[] {
  const bmap = new Map(before.map((c) => [c.id, JSON.stringify(c)]));
  return after.filter((c) => bmap.get(c.id) !== JSON.stringify(c)).map((c) => c.id);
}

console.log("\nA. THE COLUMN RENDERS IN sort_order ORDER");
{
  is("  app/ideas is A,B,C,D,E — sort_order ascending", ids(COL()), ["A", "B", "C", "D", "E"]);

  /* POSITIVE CONTROL 1 — the assertion can fail. Shuffle ONE card's sort_order
   * and the rendered order must change. Without this, an assertion that the
   * order equals the fixture's own array order proves only that nothing sorted
   * anything. */
  const shuffled = FIXTURE.map((c) => (c.id === "E" ? { ...c, sort_order: 6.5 } : c));
  is("  CONTROL: E's sort_order 12 → 6.5 moves it to second", ids(columnCards(shuffled, "app", "ideas")), ["A", "E", "B", "C", "D"]);

  /* POSITIVE CONTROL 2 — the sort is doing the work, not the input order. Feed
   * the same cards in REVERSE and the output must be identical. */
  is("  CONTROL: input reversed, output unchanged", ids(columnCards([...FIXTURE].reverse(), "app", "ideas")), ["A", "B", "C", "D", "E"]);

  is("  the other column and the other board are excluded", nonEmpty(COL(), "card in app/ideas").filter((c) => c.stage !== "ideas" || roadmapBoardOf(c) !== "app").map((c) => c.id), []);
  is("  in_plan is its own column", ids(columnCards(FIXTURE, "app", "in_plan")), ["X"]);
  is("  the Clubhouse board is its own board", ids(columnCards(FIXTURE, "clubhouse", "ideas")), ["Y"]);
  is("  an empty column is empty, not an error", ids(columnCards(FIXTURE, "clubhouse", "shipped")), []);
}

console.log("\nB. THE ORDER IS TOTAL — IT CANNOT RESHUFFLE ON RELOAD");
{
  // Two rows tied on sort_order AND on created_at: exactly the Clubhouse seed's
  // shape. Only id can separate them, and it must, in both input orders.
  const tie = [card("m", 3), card("n", 3)];
  is("  tied sort_order + tied created_at → id decides", ids([...tie].sort(compareBoardOrder)), ["m", "n"]);
  is("  ...and decides the same way from the other input order", ids([...tie].reverse().sort(compareBoardOrder)), ["m", "n"]);
  is("  CONTROL: untie created_at and it wins over id", ids([card("n", 3, "ideas", "2026-01-01T00:00:00.000Z"), card("m", 3)].sort(compareBoardOrder)), ["n", "m"]);
  is("  sort_order still outranks both", ids([card("n", 1), card("m", 3)].sort(compareBoardOrder)), ["n", "m"]);
  // No comparison may return NaN — a NaN comparator makes Array.sort's output
  // implementation-defined, which is the definition of an order that reshuffles.
  const all = [...FIXTURE, ...tie];
  const pairs: number[] = [];
  for (const a of all) for (const b of all) pairs.push(compareBoardOrder(a, b));
  is("  no comparison returns NaN", nonEmpty(pairs, "comparator result").filter((n) => Number.isNaN(n)).length, 0);
}

console.log("\nC. A REORDER WRITES sort_order AND NOTHING ELSE");
{
  const plan = planReorder(COL(), "D", "B"); // D up to just ahead of B
  if (plan.kind !== "write") { bad("  moving D ahead of B plans a write", `got ${plan.kind}`); }
  else {
    is("  the patch has exactly one key", Object.keys(plan.patch), ["sort_order"]);
    is("  stage_entered_at is NOT in the patch", "stage_entered_at" in plan.patch, false);
    is("  stage is NOT in the patch", "stage" in plan.patch, false);
    is("  it is the midpoint of A(6) and B(7)", plan.patch.sort_order, 6.5);

    const after = applyPatch(FIXTURE, "D", plan.patch);
    is("  EXACTLY ONE ROW CHANGED", changedRows(FIXTURE, after), ["D"]);
    is("  the column now reads A,D,B,C,E", ids(columnCards(after, "app", "ideas")), ["A", "D", "B", "C", "E"]);
    is("  every OTHER card's sort_order is untouched", nonEmpty(after.filter((c) => c.id !== "D"), "unmoved card")
      .filter((c) => c.sort_order !== FIXTURE.find((f) => f.id === c.id)!.sort_order).map((c) => c.id), []);
    is("  EVERY card's stage_entered_at is untouched, D included", nonEmpty(after, "card after the reorder")
      .filter((c) => c.stage_entered_at !== FIXTURE.find((f) => f.id === c.id)!.stage_entered_at).map((c) => c.id), []);
    is("  every card's stage is untouched", nonEmpty(after, "card after the reorder")
      .filter((c) => c.stage !== FIXTURE.find((f) => f.id === c.id)!.stage).map((c) => c.id), []);
  }
}

console.log("\nD. THE ORDER SURVIVES A RELOAD");
{
  // A reload re-reads the rows from Postgres, which has NO ORDER BY guarantee
  // of its own for ties and may hand them back in any order. Round-trip the
  // written state through several shuffles and the column must read the same.
  const plan = planReorder(COL(), "E", "A"); // E to the top
  if (plan.kind !== "write") bad("  moving E to the top plans a write");
  else {
    const after = applyPatch(FIXTURE, "E", plan.patch);
    const want = ids(columnCards(after, "app", "ideas"));
    is("  E is first after the write", want, ["E", "A", "B", "C", "D"]);
    /* Every rotation of the row list plus its reverse — DERIVED from the data,
     * not a random shuffle, so this suite cannot be flaky and cannot pass by
     * luck. Postgres has no ORDER BY guarantee the client can lean on here. */
    const fetches: KanbanCard[][] = [];
    for (let r = 0; r < after.length; r++) fetches.push([...after.slice(r), ...after.slice(0, r)]);
    fetches.push([...after].reverse());
    is("  every rotation and the reverse render the same column",
      nonEmpty(fetches, "simulated reload").filter((rows) => JSON.stringify(ids(columnCards(rows, "app", "ideas"))) !== JSON.stringify(want)).length, 0);
    /* CONTROL: those same fetches DO come out differently without the sort —
     * proving the agreement above is the comparator's doing, not the fixture's. */
    is("  CONTROL: without the sort, the same fetches disagree",
      nonEmpty(fetches, "simulated reload").filter((rows) =>
        JSON.stringify(ids(rows.filter((c) => c.stage === "ideas" && roadmapBoardOf(c) === "app"))) !== JSON.stringify(want)).length > 0, true);
  }
}

console.log("\nE. A NO-OP DROP WRITES NOTHING");
{
  is("  dropping a card on ITSELF", planReorder(COL(), "C", "C").kind, "noop");
  is("  dropping a card on the one directly BELOW it (lands where it already is)", planReorder(COL(), "B", "C").kind, "noop");
  is("  dropping the LAST card at the end of its column", planReorder(COL(), "E", null).kind, "noop");
  is("  a card that is not in the column", planReorder(COL(), "X", "B").kind, "noop");
  is("  CONTROL: the neighbouring drop that DOES move something still writes", planReorder(COL(), "B", "A").kind, "write");
  is("  CONTROL: dropping a NON-last card at the end still writes", planReorder(COL(), "A", null).kind, "write");
}

console.log("\nF. UP AND DOWN PRODUCE THE SAME RESULT AS THE DRAG");
{
  // For every card and both directions: the buttons' target, run through the
  // same planReorder the drag uses, must equal a plain array move by one place.
  const col = nonEmpty(COL(), "card in the column");
  const rows: string[] = [];
  for (const c of col) {
    for (const delta of [-1, 1] as const) {
      const i = col.findIndex((x) => x.id === c.id);
      const t = stepTarget(col, c.id, delta);
      const atEnd = (delta === -1 && i === 0) || (delta === 1 && i === col.length - 1);
      if (atEnd) { rows.push(t === null ? "" : `${c.id}${delta}: expected disabled, got ${JSON.stringify(t)}`); continue; }
      if (t === null) { rows.push(`${c.id}${delta}: expected a target, got null`); continue; }
      const plan = planReorder(col, c.id, t.beforeId);
      if (plan.kind !== "write") { rows.push(`${c.id}${delta}: planned ${plan.kind}, expected write`); continue; }
      const got = ids(columnCards(applyPatch(FIXTURE, c.id, plan.patch), "app", "ideas"));
      const want = ids(col.slice()); const [moved] = want.splice(i, 1); want.splice(i + delta, 0, moved);
      if (JSON.stringify(got) !== JSON.stringify(want)) rows.push(`${c.id}${delta}: got ${got.join("")} want ${want.join("")}`);
    }
  }
  is("  every card, both directions, matches a one-place array move", nonEmpty(rows, "card/direction pair").filter(Boolean), []);
  is("  the top card cannot go up", stepTarget(col, "A", -1), null);
  is("  the bottom card cannot go down", stepTarget(col, "E", 1), null);
  is("  Move up on D lands ahead of C, the same target a drag onto C gives", stepTarget(col, "D", -1)?.beforeId, "C");
  is("  Move down on D reaches PAST E and appends", stepTarget(col, "D", 1)?.beforeId, null);
  // Up then down returns the card to where it started.
  const up = stepTarget(col, "C", -1)!; const p1 = planReorder(col, "C", up.beforeId);
  const mid = p1.kind === "write" ? applyPatch(FIXTURE, "C", p1.patch) : FIXTURE;
  const col2 = columnCards(mid, "app", "ideas");
  const down = stepTarget(col2, "C", 1)!; const p2 = planReorder(col2, "C", down.beforeId);
  const back = p2.kind === "write" ? applyPatch(mid, "C", p2.patch) : mid;
  is("  up then down is a round trip", ids(columnCards(back, "app", "ideas")), ["A", "B", "C", "D", "E"]);
}

console.log("\nG. MOVING BETWEEN COLUMNS STILL RESETS THE CLOCK");
{
  const NOW = "2026-09-03T12:00:00.000Z";
  const plan = planMove(FIXTURE, "D", "in_progress", NOW);
  if (plan.kind !== "write") bad("  moving D to In progress plans a write", `got ${plan.kind}`);
  else {
    is("  the patch carries stage, sort_order AND stage_entered_at", Object.keys(plan.patch).sort(), ["sort_order", "stage", "stage_entered_at"]);
    is("  stage_entered_at IS reset", plan.patch.stage_entered_at, NOW);
    is("  it appends to the end of the target column", plan.patch.sort_order, 1); // in_progress is empty on this board
    const after = applyPatch(FIXTURE, "D", plan.patch);
    is("  exactly one row changed", changedRows(FIXTURE, after), ["D"]);
    is("  no OTHER card's clock moved", nonEmpty(after.filter((c) => c.id !== "D"), "unmoved card")
      .filter((c) => c.stage_entered_at !== FIXTURE.find((f) => f.id === c.id)!.stage_entered_at).map((c) => c.id), []);
  }
  is("  moving a card to the column it is already in is a no-op", planMove(FIXTURE, "D", "ideas", NOW).kind, "noop");
  is("  moving a card that does not exist is a no-op", planMove(FIXTURE, "nope", "shipped", NOW).kind, "noop");
  // The target column is scoped to the card's OWN board: D must not be placed
  // after a Clubhouse card that happens to share the stage name.
  const m2 = planMove(FIXTURE, "D", "in_plan", NOW);
  is("  the append point ignores the other board's cards", m2.kind === "write" ? m2.patch.sort_order : null, 2); // app/in_plan holds X at 1
}

console.log("\nH. THE MIDPOINT RULE — ONE ROW, NOT A RENUMBER");
{
  const sib = [{ id: "p", sort_order: 4 }, { id: "q", sort_order: 5 }, { id: "r", sort_order: 9 }];
  is("  between two neighbours → their midpoint", sortOrderForDrop(sib, "r"), 7);
  is("  ahead of the first → one below it", sortOrderForDrop(sib, "p"), 3);
  is("  null → after the last", sortOrderForDrop(sib, null), 10);
  is("  an unknown beforeId → after the last, never NaN", sortOrderForDrop(sib, "ghost"), 10);
  is("  an empty column → 1", sortOrderForDrop([], null), 1);
  is("  an all-negative column still appends LAST", sortOrderForDrop([{ id: "a", sort_order: -3 }, { id: "b", sort_order: -1 }], null) > -1, true);
  // 40 successive halvings of one gap stay strictly ordered in double precision.
  let lo = 1, hi = 2, collapsed = 0;
  for (let i = 0; i < 40; i++) { const mid = sortOrderForDrop([{ id: "l", sort_order: lo }, { id: "h", sort_order: hi }], "h"); if (!(mid > lo && mid < hi)) collapsed++; hi = mid; }
  is("  40 halvings of one gap never collapse", collapsed, 0);
}

console.log("\nI. THE VIEW'S TWO WRITE PATHS STAY SEPARATE");
{
  /* A source guard, narrow on purpose: the ONLY mention of stage_entered_at in
   * the roadmap view is the one moveCard passes to planMove. If a later edit
   * adds one to the reorder path, this count goes to 2 and this fails. */
  const view = readFileSync("src/app/(internal)/tech/tech-roadmap/RoadmapView.tsx", "utf8");
  const mentions = nonEmpty(
    view.split("\n").map((l, i) => ({ line: i + 1, text: l.trim() })).filter((x) => x.text.includes("stage_entered_at")),
    "line mentioning stage_entered_at (the scan must find the explanatory comment, or it is scanning nothing)",
  );
  is("  every mention of stage_entered_at in the view is a COMMENT, never code",
    mentions.filter((x) => !x.text.startsWith("//") && !x.text.startsWith("*")).map((x) => `${x.line}: ${x.text.slice(0, 60)}`), []);
  is("  the reorder callback exists and is admin-gated", /const reorder = useCallback\(async[\s\S]{0,120}if \(!isAdmin\) return;/.test(view), true);
  is("  the move callback is admin-gated", /const moveCard = useCallback\(async[\s\S]{0,120}if \(!isAdmin\) return;/.test(view), true);
  is("  the drop router is admin-gated", /const handleDrop = useCallback[\s\S]{0,260}if \(!id \|\| !isAdmin\) return;/.test(view), true);
  is("  cards are only draggable for an admin", /draggable=\{isAdmin\}/.test(view), true);
  is("  the up/down controls are behind isAdmin", /\{isAdmin && <OrderInColumn/.test(view), true);
  // The disclosure footer must not still claim a column move is the only write.
  is("  the footer no longer says moving between columns is the only write",
    /except moving a card between columns, which resets that card's clock\.`/.test(view), false);
  is("  CONTROL: the footer sentence is present in its corrected form",
    /and changing a card's order inside a column, which does not/.test(view), true);
}

console.log(`\n${fails.length ? "FAIL" : "PASS"} — ${pass} assertions, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  · ${f}`); process.exit(1); }
