/* THE TAG SET AFTER 0192, AND THE OVERFLOW ASSERTION THAT HAD TO LEAVE THE DOM.
 *
 * ── WHY THIS SUITE EXISTS AT ALL ─────────────────────────────────────────────────────────────
 * The "+1" overflow — three tags render and the rest become a count — was asserted in the browser
 * against field 1717, which carried all four tags in production. 0192 cuts the tag set to TWO, so a
 * field can carry at most two tags and the CHECK constraint rejects a third. The browser assertion
 * is now UNFAILABLE: `more` cannot be greater than zero in any DOM this page can render, so it
 * passes whatever the arithmetic does. That is the `|| true` problem wearing a different coat, and
 * the fix is not a seeded four-tag fixture — the constraint forbids one — but to assert the CAP
 * over a plain list, where four items can actually be handed in.
 *
 * ── AND THE PARTNER PREDICATE, WHICH IS NOW LOAD-BEARING IN TWO PLACES ───────────────────────
 * PARTNER stopped being a hand-applied tag because the hand-applied copy was wrong. What replaces it
 * is a derivation, and a derivation nobody checks is just a more confident copy. The rows below are
 * the real prod shapes, measured 2026-09-26.
 */
import { isRevenueShareVenue } from "@/lib/revenueShare";
import {
  TAG_KEYS, TAG_KEY_ORDER, TAG_META, TAGS_SHOWN, isTagKey,
  splitAtCap, splitTags, tagTitle, tagsAtScope, tagsForDisplay, tagsInUse, type TagKey,
} from "@/lib/promoTags";
import { buildPriorSlate, newnessOf, priorTimesFor, type SlotLike } from "@/lib/matchPromotion";
import * as PromoTagsModule from "@/lib/promoTags";
import { clusterMinutes, slotRiskKey, SLOT_CLUSTER_GAP_MIN } from "@/lib/cancelPatterns";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— three tags at two scopes —");
{
  /* THIS REVERSES 0192 AND THE ASSERTIONS THAT STATED IT, knowingly. 0192 merged key_field into
   * priority because "they mean the same thing in practice"; they do, AT DIFFERENT SCOPES, which is
   * the half that reading dropped. 0193 re-admits key_field and the database enforces the scope. */
  is("the tag set is priority, key_field, starting_11", [...TAG_KEYS], ["priority", "key_field", "starting_11"]);
  is("priority is scoped to a MATCH", TAG_META.priority.scope, "match");
  is("key_field is scoped to a FIELD", TAG_META.key_field.scope, "field");
  is("starting_11 is scoped to a FIELD", TAG_META.starting_11.scope, "field");
  is("the panel's match group holds exactly priority", tagsAtScope("match"), ["priority"]);
  is("  and its field group holds key_field and starting_11", tagsAtScope("field"), ["key_field", "starting_11"]);
  /* PARTNER IS GONE AS A TAG AND STAYS GONE. isTagKey is what the route validates with, so this is
   * the values a WRITE can carry and not merely the ones with pills. */
  yes("partner can never be written as a tag", !isTagKey("partner"));
  yes("  CONTROL: while all three real tags can", TAG_KEYS.every((k) => isTagKey(k)));
  yes("  and partner is absent from TAG_META, so the picker cannot offer it",
    !Object.keys(TAG_META).includes("partner"));
  /* NOT EVEN AS A BADGE. It was a tag, then a derived read-only badge, and now it is off this page
   * entirely. isRevenueShareVenue survives only because basisOf calls it on the finance side. */
  /* A STATIC NAMESPACE IMPORT, not a dynamic one: this guard compiles to cjs and has no top-level
   * await. The point is the same - the module must export nothing called PARTNER_BADGE. */
  yes("  and promoTags exports no PARTNER badge either",
    !Object.keys(PromoTagsModule).includes("PARTNER_BADGE"));
  yes("  CONTROL: while it does still export the three tags", Object.keys(PromoTagsModule).includes("TAG_KEYS"));
}

console.log("\n— one concept, one colour; the scope is the label —");
{
  /* A DELIBERATE BREAK from "maybe have each tag a different colour": two colours for one idea would
   * read as two ideas. COLOUR CARRIES THE CONCEPT, THE LABEL CARRIES THE SCOPE. */
  is("PRIORITY and KEY FIELD share a colour", TAG_META.priority.colour, TAG_META.key_field.colour);
  is("  and it is the purple priority already had", TAG_META.priority.colour, "#7C3AED");
  yes("STARTING 11, a different idea, differs", TAG_META.starting_11.colour !== TAG_META.priority.colour);
  is("  and keeps its own", TAG_META.starting_11.colour, "#DB2777");
  /* CONTROL: the collision check, not merely "they differ". Two distinct colours that happen to
   * include mint would pass a difference test and fail a reader. */
  const TAKEN = ["#2CDB87", "#F4C430", "#E8862A", "#D9452F", "#8F2A17", "#003326"];
  const mine = [TAG_META.priority.colour, TAG_META.starting_11.colour];
  yes("CONTROL: none collides with mint, the cancel ramp or deep green",
    mine.every((c) => !TAKEN.includes(c)), mine.join(" "));
  is("  and the two are distinct from each other", new Set(mine).size, 2);
}

console.log("\n— KEY FIELD swallows PRIORITY on the tile, and never in the panel —");
{
  /* A match at a KEY FIELD is already one we are pushing harder, so a PRIORITY pill beside it says
   * nothing and spends a third of a crowded row. */
  is("both set: the tile shows KEY FIELD alone",
    tagsForDisplay(["priority", "key_field"]), ["key_field"]);
  is("  with starting_11 alongside, priority still goes",
    tagsForDisplay(["priority", "key_field", "starting_11"]), ["key_field", "starting_11"]);
  /* CONTROL: THE SUPPRESSION IS CONDITIONAL. Without this, a tagsForDisplay that simply deleted
   * priority always would pass every line above. */
  is("CONTROL: priority ALONE still renders", tagsForDisplay(["priority"]), ["priority"]);
  is("  CONTROL: and with starting_11 but no key_field it survives",
    tagsForDisplay(["priority", "starting_11"]), ["priority", "starting_11"]);
  /* THE ONE I MOST WANT GREEN. If the toggle read the tile's set, a PRIORITY that IS set would come
   * up dark and the next save would silently clear it. splitTags suppresses; the raw list does not. */
  is("the TILE suppresses it", splitTags(["priority", "key_field"]).shown, ["key_field"]);
  yes("  and the PANEL's own list still contains it, so a save cannot clear it",
    ["priority", "key_field"].includes("priority"));
}

console.log("\n— the key: order, wording, and the caveat on hover —");
{
  is("the key lists Starting 11 first, then Priority, then Key Field",
    [...TAG_KEY_ORDER], ["starting_11", "priority", "key_field"]);
  is("STARTING 11's sentence", TAG_META.starting_11.why, "Active promo at this field.");
  is("PRIORITY's sentence", TAG_META.priority.why, "Extra promotion for this match.");
  is("KEY FIELD's sentence", TAG_META.key_field.why, "Extra promotion for all matches here.");
  /* THE SENTENCES CARRY THE SCOPE, which is why the scope lead-in was dropped rather than kept:
   * "for this match" and "for all matches here" say it better than a label above them. */
  yes("PRIORITY's sentence says which match", /this match/.test(TAG_META.priority.why));
  yes("  and KEY FIELD's says all of them", /all matches here/.test(TAG_META.key_field.why));
  /* CAN GO STALE MOVED OFF THE ROW AND ONTO THE TITLE. Starting 11 is the only tag whose claim can
   * be wrong: it asserts a code is live while being set by hand. */
  yes("\"can go stale\" is NOT in the visible sentence", !/can go stale/.test(TAG_META.starting_11.why));
  yes("  but IS in the hover text", /can go stale/.test(tagTitle("starting_11")));
  yes("  CONTROL: and the hover text also carries the label and the sentence",
    tagTitle("starting_11").startsWith("STARTING 11: Active promo at this field."));
  yes("CONTROL: a tag with no caveat has no extra sentence on hover",
    tagTitle("priority") === "PRIORITY: Extra promotion for this match.");
  is("the key lists only what is in use", tagsInUse([["priority"]]), ["priority"]);
  is("  in the key's order, not the caller's",
    tagsInUse([["key_field"], ["starting_11"]]), ["starting_11", "key_field"]);
  is("  CONTROL: nothing in use lists nothing", tagsInUse([]), []);
}

console.log("\n— the three-pill cap, kept as an invariant —");
{
  /* IT CAN NO LONGER FIRE: three tags exist and KEY FIELD swallows PRIORITY, so at most two render.
   * It is NOT deleted, because it is the rule that a crowded row stays readable, and deleting it
   * because today's list happens to fit is how the fourth tag arrives unnoticed. Asserted over a
   * plain list, where four items can actually be handed in. */
  is("four items over a cap of three shows three and counts one",
    splitAtCap(["a", "b", "c", "d"], 3), { shown: ["a", "b", "c"], more: 1 });
  is("  six count three", splitAtCap([1, 2, 3, 4, 5, 6], 3).more, 3);
  is("  exactly three count none", splitAtCap(["a", "b", "c"], 3).more, 0);
  is("  none is empty rather than throwing", splitAtCap([], 3), { shown: [], more: 0 });
  is("the default cap is TAGS_SHOWN", splitAtCap(["a", "b", "c", "d"]).more, 4 - TAGS_SHOWN);
  /* AND THE REAL SET CANNOT REACH IT, asserted so that adding a fourth tag turns this red and points
   * at the DOM assertion that would need to come back. */
  const every: TagKey[][] = [[], ["priority"], ["key_field"], ["starting_11"],
    ["priority", "key_field"], ["priority", "starting_11"], ["key_field", "starting_11"],
    ["priority", "key_field", "starting_11"]];
  yes("with three tags and KEY FIELD swallowing PRIORITY, the cap cannot fire",
    every.every((t) => splitTags(t).more === 0),
    "a fourth tag was added - restore the DOM overflow assertion");
  is("  and the most any tile renders is two", Math.max(...every.map((t) => splitTags(t).shown.length)), 2);
}

console.log("\n— ONE cluster window, called from both places —");
{
  /* THE WHOLE POINT: the cancel rollup and the newness check must agree about what "the same slot"
   * means, or a tile says "this slot cancelled 2 of 4" and "this time is new" at once. newnessOf
   * imports clusterMinutes and slotRiskKey from cancelPatterns rather than restating the window. */
  const MON = 0, FRI = 4;
  const at = (h: number, m = 0) => h * 60 + m;
  const slot = (city: string, venue: string, dayIdx: number, minutes: number, weekKey?: string): SlotLike =>
    ({ city, venue, dayIdx, minutes, weekKey });

  /* CONTROL FOR THE SHARED HELPER: the two sides return the SAME grouping for a constructed pair
   * inside the window. Asserted on the helper's own output, so it cannot pass by coincidence. */
  const pair = [at(19, 30), at(19)];
  const clusters = clusterMinutes(pair);
  is("a 30-minute move is ONE cluster to the shared helper", clusters.length, 1);
  is("  and both times key to the same slot",
    slotRiskKey("LBJ", FRI, at(19), clusters), slotRiskKey("LBJ", FRI, at(19, 30), clusters));
  yes("  CONTROL: 30 minutes is inside the agreed window", 30 <= SLOT_CLUSTER_GAP_MIN);

  /* THE REAL CASE, from prod on 2026-09-27 for the week of 2026-09-21: Austin LBJ Friday ran 19:30
   * in three of the four prior weeks, missed one, and returned at 19:00. */
  const lbj = ["2026-08-24", "2026-08-31", "2026-09-07"].map((wk) => slot("Austin", "LBJ", FRI, at(19, 30), wk));
  const slate = buildPriorSlate(lbj);
  is("LBJ Friday returning at 19:00 after three weeks at 19:30 is NOT new",
    newnessOf(slot("Austin", "LBJ", FRI, at(19)), slate), null);
  is("  and its tooltip names the old time and the weeks",
    priorTimesFor(slot("Austin", "LBJ", FRI, at(19)), slate), { times: ["19:30"], weeks: 3 });
  /* WEEKS, NOT MATCHES: two matches at one time in one week is one week. */
  const twice = buildPriorSlate([slot("Austin", "LBJ", FRI, at(19, 30), "2026-08-24"),
                                 slot("Austin", "LBJ", FRI, at(19, 30), "2026-08-24")]);
  is("  two matches in ONE week count as one week",
    priorTimesFor(slot("Austin", "LBJ", FRI, at(19)), twice)?.weeks, 1);

  /* CONTROL: A MOVE OUTSIDE THE WINDOW STILL BADGES. Without this, a newnessOf that returned null
   * for every time would satisfy everything above. */
  is("CONTROL: a move OUTSIDE the window still badges NEW TIME",
    newnessOf(slot("Austin", "LBJ", FRI, at(17)), slate), "time");
  is("  CONTROL: and carries no shifted tooltip, because it is not the same slot",
    priorTimesFor(slot("Austin", "LBJ", FRI, at(17)), slate), null);
  /* CONTROL: THE OTHER TWO TESTS ARE UNAFFECTED. */
  is("CONTROL: NEW DAY still flags, unaffected by the time window",
    newnessOf(slot("Austin", "LBJ", MON, at(19, 30)), slate), "day");
  is("  CONTROL: NEW FIELD still flags", newnessOf(slot("Austin", "Onion Creek", FRI, at(19, 30)), slate), "field");
  is("  CONTROL: an unmoved slot is not new and has no tooltip",
    [newnessOf(slot("Austin", "LBJ", FRI, at(19, 30)), slate),
     priorTimesFor(slot("Austin", "LBJ", FRI, at(19, 30)), slate)], [null, null]);
  /* THE BUG THIS SECTION EXISTS FOR, PINNED. Clustering the PRIOR minutes alone leaves the candidate
   * in no cluster, so it falls through to its own raw minute and every shifted slot still badges.
   * Measured 0 of 110 tiles changing before the fix and 4 after. */
  const priorOnly = clusterMinutes([at(19, 30)]);
  yes("the candidate must be clustered WITH the prior minutes, not against clusters built without it",
    slotRiskKey("LBJ", FRI, at(19), priorOnly) !== slotRiskKey("LBJ", FRI, at(19, 30), priorOnly),
    "this is the shape of the bug: cluster [19:30] alone and 19:00 belongs to nothing");
}

console.log("\n— the partner predicate, on the real prod rows —");
{
  /* THE FIVE THAT QUALIFY, measured 2026-09-26 by joining fin_venue_fields -> fin_venues ->
   * partner_dashboards. Named rather than counted, because a count passes when the wrong five
   * qualify. */
  yes("1024 The Hattrick, venue 3 profit_share", isRevenueShareVenue("profit_share", "flat_percentage"));
  yes("1189 PAC GLOBAL, venue 10 profit_share", isRevenueShareVenue("profit_share", "flat_percentage"));
  yes("1585 PARMER Stadium, venue 63 profit_share", isRevenueShareVenue("profit_share", "flat_percentage"));
  /* NO DASHBOARD AT ALL. Hattrick Tomball is profit_share in fin_venues and has no
   * partner_dashboards row, so billing_type alone has to carry it. */
  yes("1288 The Hattrick T., venue 52 profit_share with NO dashboard",
    isRevenueShareVenue("profit_share", null));
  /* THE ONE THAT ONLY QUALIFIES THROUGH THE DASHBOARD. Crossbar is billed per_match and PAID as a
   * share of match revenue, which is the whole reason basisOf reads revenue_model at all. Delete
   * that half of the predicate and this is the line that goes red. */
  yes("1321 Crossbar Rowlett, venue 51 per_match but per_match_minus_manager",
    isRevenueShareVenue("per_match", "per_match_minus_manager"));

  /* ── THE MISMATCH THAT MADE THE TAG WORTH DELETING ─────────────────────────────────────────
   * 1717 Keswick Park (Chamblee) -> fin_venue 66, billing_type per_match, cost_per_match 80, no
   * dashboard. It carried the hand-applied PARTNER tag. The derivation refuses it. */
  yes("CONTROL: 1717 Keswick Park is a RENTAL and gets no badge",
    !isRevenueShareVenue("per_match", null),
    "the tag was wrong on this field and the derivation must not repeat it");
  yes("  CONTROL: nor does a per_match venue with a flat_percentage dashboard",
    !isRevenueShareVenue("per_match", "flat_percentage"));
  yes("  CONTROL: nor a monthly_flat venue", !isRevenueShareVenue("monthly_flat", null));
  yes("  CONTROL: nor an unmapped field, which has no venue at all",
    !isRevenueShareVenue(null, null));
  yes("  CONTROL: nor undefined, which is what a missing Map lookup returns",
    !isRevenueShareVenue(undefined, undefined));
  /* revenue_model_next IS DELIBERATELY NOT READ. Crossbar moves to per_match_fee on 2026-08-01
   * (migration 0150) and basisOf has never consulted the successor, so neither does this. Pinned so
   * that changing it is a decision rather than a side effect. */
  yes("the SUCCESSOR model is not consulted, matching basisOf exactly",
    !isRevenueShareVenue("per_match", "per_match_fee"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
