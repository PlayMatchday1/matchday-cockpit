import "server-only"; // no-op under --conditions=react-server
// GROWTH › OFFERS: the guards on what an offer sends and what it charges.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/offers-model-test.ts
//
// Runtime assertions on computed values (src/lib/offersModel.ts, src/lib/offersServer.ts):
//   - THE DIFF IS THE REQUEST BODY: a campaign loaded and not touched sends nothing; an edit sends
//     only what changed; after launch a locked field is never sent, whatever the form says.
//   - The deal's money matches the backend's applyOfferDeal, in cents.
//   - Wall clock stays wall clock (a match's "Z" is not re-shifted; now is America/Chicago).
//   - The gate: local mode off 503, not admin 403, off the list 404, on the list through.

import { onOffersAllowlist } from "../src/lib/offersAccess";
import {
  audienceBody, chicagoWallNow, comparisonLine, costCeiling, createBody, defaultRun, endsTicket, formOf, newForm, patchBody, priceWithDeal,
  summary, wallFromMatch, withPreviewName, type Campaign, type City, type MatchOpt, type Results,
} from "../src/lib/offersModel";
import { _setOffersGateDepsForTest, offersGate } from "../src/lib/offersServer";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  XX  ${name}\n      got  ${g}\n      want ${w}`); }
};

const cities: City[] = [{ id: 1, name: "Austin" }, { id: 2, name: "Houston" }];
const matches: MatchOpt[] = [
  { id: 116, name: "Riverside Thursday", startLocal: "2026-11-02 19:00:00", fieldId: 1, fieldTitle: "Riverside Fields", cityId: 1, price: 1500, players: 11, maxPlayers: 16, minPlayers: 14, upcoming: true },
  { id: 117, name: "Mueller Friday", startLocal: "2026-11-03 19:00:00", fieldId: 2, fieldTitle: "Mueller Park", cityId: 1, price: 900, players: 0, maxPlayers: 20, minPlayers: 0, upcoming: true },
];
const results: Results = { granted: 412, heldBack: 46, saw: 412, tapped: 60, dismissed: 300, used: 38, discountGiven: 17100, cameBackAtFullPrice: 21,
  booked: { withOffer: { players: 412, booked: 37, rate: 37 / 412 }, heldBack: { players: 46, booked: 1, rate: 1 / 46 } } };
const NOW = "2026-10-29 14:30:00";
const nowF = newForm(NOW);
const draftFrom = (over: Partial<Campaign> = {}): Campaign => {
  // A campaign exactly as the backend would hold what createBody sent.
  const f = { ...nowF, name: "Austin win-back", cityIds: [1], lastPlayed: "LAPSED" as const, lastPlayedDays: 30 };
  const b = createBody(f, matches, cities) as unknown as Campaign;
  return { lastPlayedDays: null, maxMatches: null, maxRedemptions: null, buttonMatchId: null, photoUrl: null, matchIds: [], ...b, id: 9, matchScoped: false,
    status: "DRAFT", state: "DRAFT", createdByStaffEmail: "rmancuso@playmatchday.com", launchedByStaffEmail: null, launchedAt: null, results, ...over } as Campaign;
};

console.log("the diff is the request body:");
{
  const c = draftFrom();
  eq("a draft loaded and not touched sends nothing", patchBody(c, formOf(c, matches, cities), matches, cities), {});
  const f = formOf(c, matches, cities);
  eq("changing the percent sends dealAmount only", patchBody(c, { ...f, dealAmount: 40 }, matches, cities), { dealAmount: 40, headline: "40% OFF" });
  eq("LAPSED to Any time clears lastPlayedDays explicitly (else the merged row is invalid)",
    patchBody(c, { ...f, lastPlayed: "ANY", lastPlayedDays: null }, matches, cities), { lastPlayed: "ANY", lastPlayedDays: null, eyebrow: "JUST FOR YOU", caption: null });
  const typed = { ...f, copy: { headline: "HALF OFF" } };
  const c2 = { ...c, headline: "HALF OFF" };
  eq("typed copy survives a reload and is not re-sent", patchBody(c2, formOf(c2, matches, cities), matches, cities), {});
  eq("typed copy is sent as typed", patchBody(c, typed, matches, cities), { headline: "HALF OFF" });
  const old = { ...c, caption: null };
  eq("a stored 'no caption' (saved before captions) loads and sends nothing", patchBody(old, formOf(old, matches, cities), matches, cities), {});
  eq("the lapsed eyebrow carries {firstName} for the backend to fill", createBody(f, matches, cities).eyebrow, "WE MISS YOU, {firstName}");
  eq("the preview shows {firstName} as Luis", withPreviewName("WE MISS YOU, {firstName}"), "WE MISS YOU, Luis");
  eq("an emptied box goes back to the deal's text, which is no change", patchBody(c2, { ...formOf(c2, matches, cities), copy: { headline: "" } }, matches, cities), { headline: "50% OFF" });
}
{
  const c = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  const f = formOf(c, matches, cities);
  const sent = patchBody(c, { ...f, dealType: "FREE_MATCH", dealAmount: 0, cityIds: [2], holdoutPercent: 0, endsLocal: "2026-12-01 00:00:00", name: "Austin back", maxRedemptions: 50 }, matches, cities);
  eq("after launch a locked field is never sent, only name, copy and cap", Object.keys(sent).sort(), ["body", "headline", "maxRedemptions", "name"]);
  eq("after launch nothing changed sends nothing", patchBody(c, f, matches, cities), {});
}

console.log("create bodies:");
{
  const any = createBody({ ...nowF, name: "Free one", dealType: "FREE_MATCH", dealAmount: 0, usesPerPlayer: 3 }, matches, cities);
  eq("free match is dealAmount 0, any match is FIND_MATCH with no buttonMatchId",
    [any.dealType, any.dealAmount, any.usesPerPlayer, any.buttonTarget, "buttonMatchId" in any, any.matchIds], ["FREE_MATCH", 0, 3, "FIND_MATCH", false, []]);
  eq("nulls are left out of a create (lastPlayedDays, maxMatches, maxRedemptions, photoUrl)",
    ["lastPlayedDays", "maxMatches", "maxRedemptions", "photoUrl"].filter((k) => k in any), []);
  const one = createBody({ ...nowF, name: "Riverside $5", dealType: "SET_PRICE", dealAmount: 500, usesPerPlayer: 3, scope: "MATCH", matchId: 116, playedAtMatchField: true, endsLocal: "2026-11-02 19:00:00" }, matches, cities);
  eq("a specific match is one use, scoped, MATCH to that match, ending at kickoff",
    [one.usesPerPlayer, one.matchIds, one.buttonTarget, one.buttonMatchId, one.playedAtMatchField, one.endsLocal], [1, [116], "MATCH", 116, true, "2026-11-02 19:00:00"]);
  const back = createBody({ ...nowF, name: "x", playedAtMatchField: true }, matches, cities);
  eq("played-here is never sent without a match", back.playedAtMatchField, false);
  eq("the live count sends the audience and the deal, never the copy", Object.keys(audienceBody({ ...nowF, name: "x" }, matches, cities)).some((k) => ["headline", "name", "body"].includes(k)), false);
}

console.log("money, in cents, as the backend's applyOfferDeal:");
eq("50% of $15", priceWithDeal(1500, "PERCENT_OFF", 50), 750);
eq("$5 off $9", priceWithDeal(900, "AMOUNT_OFF", 500), 400);
eq("$5 off $5.40 leaves 40 cents, which is free", priceWithDeal(540, "AMOUNT_OFF", 500), 0);
eq("set price $5", priceWithDeal(1500, "SET_PRICE", 500), 500);
eq("set price above the normal price is charged as set (the backend does not cap it)", priceWithDeal(900, "SET_PRICE", 1200), 1200);
{
  const f = { ...nowF, name: "x", cityIds: [1] };
  eq("ceiling at today's top price when the backend cannot know it", costCeiling(f, { count: 458, heldBack: 46, players: 412, mostItCanCost: null }, matches),
    { cents: 750 * 412, basis: "at today's top price of $15" });
  eq("the backend's own ceiling wins when it has one", costCeiling(f, { count: 10, heldBack: 1, players: 9, mostItCanCost: 4500 }, matches), { cents: 4500, basis: null });
  eq("the use cap bounds the ceiling", costCeiling({ ...f, maxRedemptions: 10 }, { count: 458, heldBack: 46, players: 412, mostItCanCost: null }, matches)?.cents, 7500);
  eq("the summary", summary({ ...f, lastPlayed: "LAPSED", lastPlayedDays: 30 }, { count: 458, heldBack: 46, players: 412, mostItCanCost: null }, matches, cities, NOW),
    "412 Austin players who haven't played in 30+ days get 50% off one match until Sun 11:59 PM (46 more held back to measure). Most it can cost: $3,090 at today's top price of $15.");
  eq("the summary for one player", summary({ ...f, lastPlayed: "LAPSED", lastPlayedDays: 30 }, { count: 1, heldBack: 0, players: 1, mostItCanCost: null }, matches, cities, NOW),
    "1 Austin player who hasn't played in 30+ days gets 50% off one match until Sun 11:59 PM. Most it can cost: $7.50 at today's top price of $15.");
}

console.log("wall clock:");
eq("a match's startDate keeps its wall clock despite the Z", wallFromMatch("2026-11-02T19:00:00.000Z"), "2026-11-02 19:00:00");
eq("now in Chicago after DST (CST)", chicagoWallNow(new Date("2026-11-03T01:00:00Z")), "2026-11-02 19:00:00");
eq("now in Chicago in July (CDT)", chicagoWallNow(new Date("2026-07-04T01:00:00Z")), "2026-07-03 20:00:00");
eq("a Thursday runs to Sunday 11:59 PM", defaultRun("2026-10-29 14:30:27"), { startsLocal: "2026-10-29 14:30:00", endsLocal: "2026-11-01 23:59:00" });
eq("a Saturday runs to the next week's Sunday", defaultRun("2026-10-31 09:00:00").endsLocal, "2026-11-08 23:59:00");
eq("ticket within the week", endsTicket("2026-11-01 23:59:00", NOW), "Ends Sun 11:59 PM");
eq("ticket after the week", endsTicket("2026-11-09 23:59:00", NOW), "Ends Mon, Nov 9");

console.log("results:");
eq("the holdout line", comparisonLine(results), "With the offer, 9% booked. The 46 players held back with no offer: 2% booked.");
eq("nobody held back", comparisonLine({ ...results, booked: { ...results.booked, heldBack: { players: 0, booked: 0, rate: null } } }),
  "With the offer, 9% booked. Nobody was held back, so there is nothing to compare it with.");

const heldBack = (players: number, booked: number) => ({ ...results, booked: { ...results.booked, heldBack: { players, booked, rate: booked / players } } });
eq("3 held back is too few: no rates", comparisonLine(heldBack(3, 1)), "Too few players held back to compare yet (3 so far)");
eq("29 held back is still too few", comparisonLine(heldBack(29, 1)), "Too few players held back to compare yet (29 so far)");
eq("30 held back compares (the control for the two above)", comparisonLine(heldBack(30, 3)), "With the offer, 9% booked. The 30 players held back with no offer: 10% booked.");

console.log("access:");
eq("unset list is nobody", onOffersAllowlist("rmancuso@playmatchday.com", {}), false);
eq("on the list, any case", onOffersAllowlist("RMancuso@PlayMatchday.com", { OFFERS_ALLOWLIST: " rmancuso@playmatchday.com " }), true);
eq("another admin is not on it", onOffersAllowlist("someone@playmatchday.com", { OFFERS_ALLOWLIST: "rmancuso@playmatchday.com" }), false);

const fakeAdmin = (email: string) => async () => ({ ok: true as const, supabase: {} as never, appUserId: "u1", email, canEditMatches: false, canManagePlayers: false, canManagePromos: false });
const status = async (r: unknown) => (r instanceof Response ? r.status : "through");
(async () => {
  process.env.OFFERS_ALLOWLIST = "rmancuso@playmatchday.com";
  const req = (method = "GET") => new Request("http://localhost/api/offers", { method });
  _setOffersGateDepsForTest({ localModeOn: () => false, authenticateAdmin: fakeAdmin("rmancuso@playmatchday.com") });
  eq("local mode off: 503", await status(await offersGate(req())), 503);
  _setOffersGateDepsForTest({ localModeOn: () => true, authenticateAdmin: async () => ({ ok: false as const, status: 403, error: "Admins only" }) });
  eq("not an admin: 403", await status(await offersGate(req())), 403);
  _setOffersGateDepsForTest({ localModeOn: () => true, authenticateAdmin: fakeAdmin("someone@playmatchday.com") });
  eq("admin off the list: 404", await status(await offersGate(req())), 404);
  _setOffersGateDepsForTest({ localModeOn: () => true, authenticateAdmin: fakeAdmin("rmancuso@playmatchday.com") });
  eq("on the list: through (the control for the three refusals)", await status(await offersGate(req("POST"))), "through");
  _setOffersGateDepsForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass === 0 || fail > 0) process.exit(1);
})();
