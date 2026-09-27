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
  PARTNER_BADGE, TAG_KEYS, TAG_META, TAGS_SHOWN, isTagKey, splitAtCap, splitTags, tagsInUse,
  type TagKey,
} from "@/lib/promoTags";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— two tags, and the two that left —");
{
  is("the tag set is exactly priority and starting_11", [...TAG_KEYS], ["priority", "starting_11"]);
  /* THE WHOLE POINT OF THE MERGE AND THE DERIVATION. Asserted on isTagKey, which is what the API
   * route validates with — so these are the values a write can carry, not just the ones with pills. */
  yes("key_field can no longer be written", !isTagKey("key_field"));
  yes("  nor partner, which is derived now", !isTagKey("partner"));
  yes("  CONTROL: while priority still can", isTagKey("priority"));
  yes("  CONTROL: and starting_11 still can", isTagKey("starting_11"));
  /* PARTNER IS NOT IN TAG_META, which is what the picker and the legend iterate. A PARTNER entry
   * there would put it back in the tag row as a button. */
  yes("PARTNER is absent from TAG_META, so it cannot reach the picker",
    !Object.keys(TAG_META).includes("partner"));
  yes("  and it has its own read-only constant instead", PARTNER_BADGE.label === "PARTNER");
  /* THE COPY IS THE DECISION, so it is pinned. Both lines were argued over: priority says nothing
   * about "this week" because the row has no week column, and starting_11 states its own staleness
   * because nothing links it to a promo code's lifecycle. */
  is("PRIORITY's meaning does not claim a week the row cannot store",
    TAG_META.priority.meaning,
    "A field we are pushing harder. Set by hand and it stays until someone clears it.");
  yes("  and does not say \"this week\"", !/this week/i.test(TAG_META.priority.meaning));
  is("STARTING 11 says it is hand-set and can go stale",
    TAG_META.starting_11.meaning,
    "Starting 11 is live at this field. Set by hand, so it can go stale when a venue's code ends.");
  is("PARTNER's meaning is the revenue-share one",
    PARTNER_BADGE.meaning, "A revenue-share venue. A quiet week hurts the partner too.");
  /* COLOURS: the two survivors keep the ones they had, and PARTNER keeps the colour its tag used so
   * a reader who learned it does not have to relearn it. */
  is("PRIORITY keeps its colour", TAG_META.priority.colour, "#7C3AED");
  is("STARTING 11 keeps its colour", TAG_META.starting_11.colour, "#DB2777");
  is("PARTNER keeps the colour its tag had", PARTNER_BADGE.colour, "#0891B2");
  const all = [...Object.values(TAG_META).map((m) => m.colour), PARTNER_BADGE.colour];
  is("  and the three are still distinct", new Set(all).size, all.length);
}

console.log("\n— the cap, asserted where it can actually fire —");
{
  /* THE CASE THE DOM CAN NO LONGER PRODUCE. Four items, cap of three: three shown and one counted.
   * If the overflow arithmetic were deleted this line goes red, which is the whole point — the
   * browser assertion it replaces could not. */
  is("four items over a cap of three shows three and counts one",
    splitAtCap(["a", "b", "c", "d"], 3), { shown: ["a", "b", "c"], more: 1 });
  is("  six items count three", splitAtCap([1, 2, 3, 4, 5, 6], 3).more, 3);
  is("  exactly three counts none", splitAtCap(["a", "b", "c"], 3), { shown: ["a", "b", "c"], more: 0 });
  is("  two counts none", splitAtCap(["a", "b"], 3), { shown: ["a", "b"], more: 0 });
  is("  none is empty rather than throwing", splitAtCap([], 3), { shown: [], more: 0 });
  /* AND THE DEFAULT IS THE CONSTANT THE TILE RENDERS WITH, not a literal repeated here. */
  is("the default cap is TAGS_SHOWN", splitAtCap(["a", "b", "c", "d"]).more, 4 - TAGS_SHOWN);

  /* splitTags ITSELF, over the real key set. `more` is 0 for every possible input now, and that is
   * asserted rather than assumed — it is the fact that makes the DOM assertion unfailable, so if a
   * third tag is ever added this line goes red and points at the assertion that needs to come back. */
  const every: TagKey[][] = [[], ["priority"], ["starting_11"], ["priority", "starting_11"]];
  yes("with two tag keys, splitTags can never overflow",
    every.every((t) => splitTags(t).more === 0),
    "a third tag key was added - restore the DOM overflow assertion");
  is("  and it orders by TAG_KEYS, not by the caller's order",
    splitTags(["starting_11", "priority"]).shown, ["priority", "starting_11"]);
  /* A STALE key_field ROW MUST NOT RENDER. The page filters through isTagKey before splitTags, and
   * this is the belt: even handed one, splitTags drops it. */
  is("a stale key_field value is not rendered",
    splitTags(["key_field" as unknown as TagKey, "priority"]).shown, ["priority"]);
}

console.log("\n— the key lists only what is in use —");
{
  is("nothing in use lists nothing", tagsInUse(new Map()), []);
  is("one field with one tag lists one", tagsInUse(new Map([[1, ["priority"] as TagKey[]]])), ["priority"]);
  is("  two fields sharing a tag still list it once",
    tagsInUse(new Map([[1, ["priority"] as TagKey[]], [2, ["priority"] as TagKey[]]])), ["priority"]);
  is("  and both tags list in TAG_KEYS order",
    tagsInUse(new Map([[1, ["starting_11"] as TagKey[]], [2, ["priority"] as TagKey[]]])),
    ["priority", "starting_11"]);
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
