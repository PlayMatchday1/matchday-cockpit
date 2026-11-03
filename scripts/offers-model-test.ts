import "server-only"; // no-op under --conditions=react-server
// MATCH OPS › OFFERS: the guards on what an offer sends and what it charges.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/offers-model-test.ts
//
// Runtime assertions on computed values (src/lib/offersModel.ts, src/lib/offersServer.ts):
//   - THE DIFF IS THE REQUEST BODY: a campaign loaded and not touched sends nothing; an edit sends
//     only what changed; after launch a locked field is never sent, whatever the form says.
//   - The deal's money matches the backend's applyOfferDeal, in cents.
//   - Wall clock stays wall clock (a match's "Z" is not re-shifted; now is America/Chicago).
//   - The gate: config unset or wrong 503, no session 401, without Match Ops or confined to a city 404, with it through.

import { offersAccessState } from "../src/lib/offersAccess";
import { matchOpsReadGate } from "../src/lib/matchOpsAuth";
import { assertConfinedRoute } from "../src/lib/cityConfinement";
import { apiWrite, NotAuthorizedError, WriteFailedError } from "../src/lib/matchdayStageApi";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  audienceBody, chicagoWallNow, comparisonLine, costCeiling, createBody, defaultRun, endsTicket, formOf, newForm, patchBody, priceWithDeal,
  summary, wallFromMatch, withPreviewName, buttonOf, opensText, formProblem, stepUses, usesLine, stepLimit, limitLine, copyOf,
  addSection, autoCopy, canReset, copyAfterType, staleLines, staleSections, writtenForOnLoad, isRemovable, removeSection, resetCopy, sectionCollapsed, REMOVABLE_KEYS, canHidePhoto, copyAfterHide, hideUpload, extraBookingsLine, photoContentType, photoFileProblem, photoUrlOk, settableHeaders, uploadTiles, audienceText, parsePlayerIds, playerLine, notFoundLine, usedOfLimit, resultsLines, playedAtSuggestions, isAdminAccount, scopeFieldsLine, setPriceAnyWarning as anyPriceWarn, matchPicked, matchTitle, matchWhere, ranUntil, endNote, pauseNote, progressText, campaignsAfter, countWanted, lockedSummary, offerWallNow, offerZones, wallNowIn, mergeMatches, offerMatchOpt, pickerRange, withCovers, coverTiles, COUNT_BLOCK, COUNT_DEBOUNCE_MS, countState, endHasPassed, launchProblem, namedMatchIds, offersLogBody, pickerDayLabel, pickerView, fillText, fillFraction, setPriceAnyWarning, setPriceProblem, on188Line, fullBody, type Campaign, type City, type MatchOpt, type Results,
} from "../src/lib/offersModel";
import { _setOffersGateDepsForTest, errorText, GENERIC, NO_OFFERS, MAX_MATCH_PAGES, mismatches, offersGate, offersWrite, photoLinkProblem, readFirstMatchPage, readMatchesForCities, sendPreview, type OffersAuth } from "../src/lib/offersServer";
import { readOffersConfig } from "../src/lib/offersConfig";
import { assertAllowedHost, preflightWrite } from "../src/lib/matchdayStageApi";
import { makePacer, OFFERS_READ_PACE_MS, READS_STOPPED } from "../src/lib/offersPacing";
import {
  CUT_OFF_NOTE, PUSH_BODY_MAX, PUSH_BODY_SOFT, PUSH_TITLE_MAX, PUSH_TITLE_SOFT, capLine, defaultSendLocal, fillPush, mayCutOff, matchForPush, sendsToLine, pushAfterType, pushBodyOf, pushDirty, pushFormOf, pushLocked, pushProblem, pushSuggestion, pushText,
  pushesVisible, pushStatusText, reachAddsUp, reachHeadline, reachModeNote, reachRows, reachWarns, sendsToText, sendTimeNote, skippedRows, skippedTotal, type Reach, type CampaignPush,
} from "../src/lib/offersPush";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  XX  ${name}\n      got  ${g}\n      want ${w}`); }
};

const cities: City[] = [{ id: 1, name: "Austin" }, { id: 2, name: "Houston" }];
const matches: MatchOpt[] = [
  { id: 116, name: "Riverside Thursday", startLocal: "2026-11-02 19:00:00", fieldId: 1, fieldTitle: "Riverside Fields", fieldCover: "https://covers.local/riverside.jpg", cityId: 1, price: 1500, players: 11, maxPlayers: 16, minPlayers: 14, upcoming: true },
  { id: 117, name: "Mueller Friday", startLocal: "2026-11-03 19:00:00", fieldId: 2, fieldTitle: "Mueller Park", fieldCover: null, cityId: 1, price: 900, players: 0, maxPlayers: 20, minPlayers: 0, upcoming: true },
];
const results: Results = { granted: 412, heldBack: 46, saw: 412, tapped: 60, dismissed: 300, used: 38, discountGiven: 17100, cameBackAtFullPrice: 21,
  booked: { withOffer: { players: 412, booked: 37, rate: 37 / 412 }, heldBack: { players: 46, booked: 1, rate: 1 / 46 } } };
const NOW = "2026-10-29 14:30:00";
const nowF = newForm(NOW);
const draftFrom = (over: Partial<Campaign> = {}): Campaign => {
  // A campaign exactly as the backend would hold what createBody sent.
  const f = { ...nowF, name: "Austin win-back", cityIds: [1], lastPlayed: "LAPSED" as const, lastPlayedDays: 30 };
  const b = createBody(f, matches, cities) as unknown as Campaign;
  return { lastPlayedDays: null, maxMatches: null, maxRedemptions: null, buttonMatchId: null, photoUrl: null, matchIds: [], playerIds: [], fieldIds: [], ...b, id: 9, matchScoped: false,
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
  eq("an emptied headline stays empty and stops the save", [copyOf({ ...f, copy: { headline: "" } }, matches, cities).headline, formProblem({ ...f, copy: { headline: "  " } }, matches)], ["", "The popup needs a headline."]);
  eq("Reset to suggested on a typed headline sends the deal's text", patchBody(c2, { ...formOf(c2, matches, cities), copy: resetCopy(formOf(c2, matches, cities).copy, "headline") }, matches, cities), { headline: "50% OFF" });
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
  const one = createBody({ ...nowF, name: "Riverside $5", dealType: "SET_PRICE", dealAmount: 500, usesPerPlayer: 3, scope: "MATCH", matchId: 116, endsLocal: "2026-11-02 19:00:00" }, matches, cities);
  eq("a specific match is one use, scoped, MATCH to that match, ending at kickoff",
    [one.usesPerPlayer, one.matchIds, one.buttonTarget, one.buttonMatchId, one.endsLocal], [1, [116], "MATCH", 116, "2026-11-02 19:00:00"]);
  // playedAtMatchField left the backend (5f86e46, 400 "should not exist"); fieldIds replaces it.
  eq("no body ever carries playedAtMatchField", ["playedAtMatchField" in one, "playedAtMatchField" in createBody({ ...nowF, name: "x" }, matches, cities), "playedAtMatchField" in audienceBody(nowF, matches, cities)], [false, false, false]);
  eq("the live count sends the audience and the deal, never the copy", Object.keys(audienceBody({ ...nowF, name: "x" }, matches, cities)).some((k) => ["headline", "name", "body"].includes(k)), false);
}

console.log("button opens:");
{
  const any = createBody({ ...nowF, name: "x" }, matches, cities);
  eq("default is Find a match, with no buttonMatchId", [any.buttonTarget, "buttonMatchId" in any], ["FIND_MATCH", false]);
  eq("default opens line", opensText({ ...nowF, name: "x" }, matches), "↳ Opens Find a match");
  const scoped = { ...nowF, name: "x", scope: "MATCH" as const, matchId: 116, buttonTarget: "MATCH" as const, buttonMatchId: 117 };
  eq("a specific-match deal forces the button to that match and locks it", buttonOf(scoped, matches), { target: "MATCH", matchId: 116, locked: true });
  eq("...and that is what is sent, whatever the form held", [createBody(scoped, matches, cities).buttonTarget, createBody(scoped, matches, cities).buttonMatchId], ["MATCH", 116]);
  eq("an any-match offer may open one match, unlocked", buttonOf({ ...nowF, buttonTarget: "MATCH", buttonMatchId: 117 }, matches), { target: "MATCH", matchId: 117, locked: false });
  eq("its opens line", opensText({ ...nowF, buttonTarget: "MATCH", buttonMatchId: 117 }, matches), "↳ Opens Tue 7:00 PM · Mueller Friday");
  eq("a button match not picked yet stops the save", formProblem({ ...nowF, name: "x", buttonTarget: "MATCH", buttonMatchId: null }, matches), "Pick the match the button opens.");
  const live = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  const lf = formOf(live, matches, cities);
  eq("after launch, pointing the button at a match sends only the target fields",
    patchBody(live, { ...lf, buttonTarget: "MATCH", buttonMatchId: 117 }, matches, cities), { buttonTarget: "MATCH", buttonMatchId: 117 });
  const live2 = { ...live, buttonTarget: "MATCH" as const, buttonMatchId: 117 };
  eq("after launch, back to Find a match clears buttonMatchId and sends nothing else",
    patchBody(live2, { ...formOf(live2, matches, cities), buttonTarget: "FIND_MATCH", buttonMatchId: null }, matches, cities), { buttonTarget: "FIND_MATCH", buttonMatchId: null });
  eq("a launched offer with a match button loads and sends nothing", patchBody(live2, formOf(live2, matches, cities), matches, cities), {});
}

console.log("uses per player:");
eq("the stepper runs 1 to 20", [stepUses(1, -1), stepUses(3, 1), stepUses(20, 1)], [1, 4, 20]);
eq("the line", [usesLine(1), usesLine(3)], ["Each player can use it on 1 match before it ends.", "Each player can use it on up to 3 matches before it ends."]);
eq("any match sends the stepper's number", createBody({ ...nowF, name: "x", usesPerPlayer: 7 }, matches, cities).usesPerPlayer, 7);
eq("a specific match is always one use", createBody({ ...nowF, name: "x", usesPerPlayer: 7, scope: "MATCH", matchId: 117, endsLocal: "2026-11-03 19:00:00" }, matches, cities).usesPerPlayer, 1);
eq("the summary says the number", summary({ ...nowF, name: "x", cityIds: [1], usesPerPlayer: 7 }, { count: 10, heldBack: 1, players: 9, mostItCanCost: null }, matches, cities, NOW).includes("50% off 7 matches"), true);

console.log("total limit:");
eq("no limit by default, and none is sent", "maxRedemptions" in createBody({ ...nowF, name: "x" }, matches, cities), false);
eq("a limit is sent", createBody({ ...nowF, name: "x", maxRedemptions: 50 }, matches, cities).maxRedemptions, 50);
eq("the stepper starts at 1 and never goes under it", [stepLimit(null, 1), stepLimit(1, -1), stepLimit(50, 1)], [1, 1, 51]);
eq("the line", [limitLine(1), limitLine(1200)], ["The offer stops once 1 use is taken across all players.", "The offer stops once 1,200 uses are taken across all players."]);
{
  const f = { ...nowF, name: "x", cityIds: [1], usesPerPlayer: 3 };
  const count = { count: 458, heldBack: 46, players: 412, mostItCanCost: null };
  eq("most it can cost: players x uses when that is lower than the limit", costCeiling({ ...f, maxRedemptions: 5000 }, count, matches)?.cents, 750 * 412 * 3);
  eq("most it can cost: the limit when it is lower", costCeiling({ ...f, maxRedemptions: 100 }, count, matches)?.cents, 750 * 100);
  const live = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  eq("after launch, the limit is one of the fields still sent, alone", patchBody(live, { ...formOf(live, matches, cities), maxRedemptions: 80 }, matches, cities), { maxRedemptions: 80 });
  eq("after launch, back to no limit sends null", patchBody({ ...live, maxRedemptions: 80 }, { ...formOf({ ...live, maxRedemptions: 80 }, matches, cities), maxRedemptions: null }, matches, cities), { maxRedemptions: null });
}

console.log("photo:");
eq("any match: the default MatchDay photo (null)", copyOf({ ...nowF, name: "x" }, matches, cities).photoUrl, null);
eq("a specific match: that match's field cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116 }, matches, cities).photoUrl, "https://covers.local/riverside.jpg");
eq("a specific match with no cover: the default", copyOf({ ...nowF, scope: "MATCH", matchId: 117 }, matches, cities).photoUrl, null);
eq("a picked cover is sent as the photo", createBody({ ...nowF, name: "x", copy: { photoUrl: "https://covers.local/mueller.jpg" } }, matches, cities).photoUrl, "https://covers.local/mueller.jpg");
eq("picking MatchDay photo on a specific match sends no photo (null), not the cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116, copy: { photoUrl: null } }, matches, cities).photoUrl, null);
{
  const live = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  eq("after launch, changing the photo sends only photoUrl", patchBody(live, { ...formOf(live, matches, cities), copy: { photoUrl: "https://covers.local/mueller.jpg" } }, matches, cities), { photoUrl: "https://covers.local/mueller.jpg" });
  const withPhoto = { ...live, photoUrl: "https://covers.local/mueller.jpg" };
  eq("a stored photo loads and sends nothing", patchBody(withPhoto, formOf(withPhoto, matches, cities), matches, cities), {});
}

console.log("played at:");
eq("fields are sent with or without a match", [createBody({ ...nowF, name: "x", fieldIds: [1, 2] }, matches, cities).fieldIds, audienceBody({ ...nowF, fieldIds: [2] }, matches, cities).fieldIds], [[1, 2], [2]]);
eq("the list line names them", audienceText({ ...draftFrom(), fieldIds: [1, 2], cityIds: [1] }, cities, [{ id: 1, title: "Riverside Fields", cityId: 1, cover: null }, { id: 2, title: "Mueller Park", cityId: 1, cover: null }]),
  "Austin · Not played in 30+ days · Played at Riverside Fields or Mueller Park");

console.log("specific players:");
eq("ids from commas, spaces and lines, first kept, junk set aside", parsePlayerIds("10482, 10511\n9877  10482,abc,0,-3"), { ids: [10482, 10511, 9877], bad: ["abc", "0", "-3"], tooMany: false });
eq("over the cap is flagged", parsePlayerIds("1 2 3", 2), { ids: [1, 2], bad: [], tooMany: true });
// 20,000 IDS (2026-11-02): the cap is the backend's MAX_OFFER_PLAYER_IDS, not 2,000.
// (Imported here rather than in the block at the top; ES imports are hoisted either way.)
import { LOOKUP_BATCH, lookupInBatches, MAX_OFFER_PLAYER_IDS, pastedLine, playerLookupBlock, refreshedLine, type Lookup, holdoutFor, playersHoldoutOn, heldBackLine, PLAYERS_HOLDOUT_MIN, DEFAULT_HOLDOUT_PERCENT } from "../src/lib/offersModel";
{
  const big = Array.from({ length: 20_001 }, (_, i) => i + 1);
  const t0 = Date.now();
  const p = parsePlayerIds(big.join(",") + ",5,5,7");
  eq("the default cap is 20,000 (was 2,000), and 20,001 is flagged", [MAX_OFFER_PLAYER_IDS, p.ids.length, p.ids[19_999], p.tooMany], [20_000, 20_000, 20_000, true]);
  eq("a 20,000-id paste parses fast (Set dedupe, not includes)", Date.now() - t0 < 500, true);
  eq("5,829 ids with repeats: deduped, nothing flagged", (() => { const q = parsePlayerIds([...big.slice(0, 5829), 1, 2, 3].join(",")); return [q.ids.length, q.tooMany]; })(), [5829, false]);
  eq("pasted line, with not found", pastedLine(5829, { players: Array.from({ length: 5812 }, (_, i) => ({ id: i, name: null, city: null, matchesPlayed: 0 })), notFound: Array.from({ length: 17 }, (_, i) => i) }),
    "5,829 pasted · 5,812 found · 17 not found");
  eq("pasted line, all found / one", [pastedLine(2, { players: [{ id: 1, name: null, city: null, matchesPlayed: 0 }, { id: 2, name: null, city: null, matchesPlayed: 0 }], notFound: [] }), pastedLine(1, { players: [], notFound: [9] })],
    ["2 pasted · 2 found", "1 pasted · 0 found · 1 not found"]);
}
// REFRESH SAYS WHAT IT DID (2026-11-03): a reload that brings back the same list looked like a dead button.
{
  const at = Date.UTC(2026, 10, 3, 20, 14, 5); // 2:14:05 PM in Chicago (CST, UTC-6)
  eq("reading / read / nothing on screen yet", [refreshedLine(true, at), refreshedLine(true, null), refreshedLine(false, at), refreshedLine(false, null)],
    ["Refreshing…", "Refreshing…", "Updated 2:14:05 PM", ""]);
  eq("the time is Chicago's, not the machine's (summer: UTC-5)", refreshedLine(false, Date.UTC(2026, 6, 1, 19, 0, 0)), "Updated 2:00:00 PM");
}
// SAVE AND LAUNCH WAIT FOR THE ID LOOKUP (review 2026-11-02, OfferPanel): blocked until the answer is for the ids on screen
// and playerIds is that list less the not-found ones.
{
  const L = (notFound: number[]): Lookup => ({ players: [], notFound });
  const s = { players: true, typed: [1, 2, 3], answeredFor: "1,2,3", lookup: L([2]), failed: false, sending: [1, 3] };
  const wait = "Still looking up the IDs.";
  eq("answered for the list on screen, not-found dropped: nothing blocks (the control)", playerLookupBlock(s), null);
  eq("no answer yet / answer for an older list / sending still the typed list", [
    playerLookupBlock({ ...s, answeredFor: null, lookup: null }), playerLookupBlock({ ...s, answeredFor: "1,2" }), playerLookupBlock({ ...s, sending: [1, 2, 3] }),
  ], [wait, wait, wait]);
  eq("the lookup failed for this list: blocked with its own reason", playerLookupBlock({ ...s, lookup: null, failed: true }), "Couldn't look the IDs up. Change the list to try again.");
  eq("filters, or no ids typed: the lookup never blocks", [playerLookupBlock({ ...s, players: false, answeredFor: null }), playerLookupBlock({ ...s, typed: [], answeredFor: null })], [null, null]);
}
// SPECIFIC PLAYERS HOLDOUT (backend playersHoldout, 2026-11-02): 200 or more ids hold back the percent asked, fewer nobody.
{
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const pl = (n: number, pct: number) => ({ ...nowF, name: "x", audienceMode: "PLAYERS" as const, playerIdsText: ids(n).join(","), playerIds: ids(n), holdoutPercent: pct });
  eq("199 ids: nobody held back, whatever the percent; 200: the percent, 0 allowed", [holdoutFor(pl(199, 10)), holdoutFor(pl(200, 10)), holdoutFor(pl(200, 0)), holdoutFor(pl(5000, 25)), PLAYERS_HOLDOUT_MIN], [0, 10, 0, 25, 200]);
  eq("the control shows from 200 on, never for filters", [playersHoldoutOn(pl(199, 10)), playersHoldoutOn(pl(200, 10)), playersHoldoutOn({ audienceMode: "FILTERS", playerIds: ids(500) })], [false, true, false]);
  eq("filters keep their own percent (the control)", holdoutFor({ ...nowF, holdoutPercent: 15 }), 15);
  eq("what is sent: the holdout in the save and in the count", [fullBody(pl(250, 10), matches, cities).holdoutPercent, audienceBody(pl(250, 10), matches, cities).holdoutPercent, fullBody(pl(3, 10), matches, cities).holdoutPercent], [10, 10, 0]);
  const short = draftFrom({ audienceMode: "PLAYERS", playerIds: [7, 8], cityIds: [], lastPlayed: "ANY", lastPlayedDays: null, holdoutPercent: 0 });
  const long = draftFrom({ audienceMode: "PLAYERS", playerIds: ids(300), cityIds: [], lastPlayed: "ANY", lastPlayedDays: null, holdoutPercent: 0 });
  const fs = formOf(short, matches, cities), fl = formOf(long, matches, cities);
  eq("a saved short list loads with the default ready, and isn't a change", [fs.holdoutPercent, patchBody(short, fs, matches, cities).holdoutPercent], [DEFAULT_HOLDOUT_PERCENT, undefined]);
  eq("...grown to 200 it sends the default", patchBody(short, { ...fs, playerIds: ids(200), playerIdsText: ids(200).join(",") }, matches, cities).holdoutPercent, 10);
  eq("a saved long list set to 0 stays 0, and isn't a change", [fl.holdoutPercent, patchBody(long, fl, matches, cities).holdoutPercent], [0, undefined]);
  eq("the line under the list", [heldBackLine(584), heldBackLine(0)], ["584 held back to measure", "0 held back to measure"]);
}
{
  const pf = { ...nowF, name: "x", audienceMode: "PLAYERS" as const, playerIdsText: "7, 8", playerIds: [7, 8], cityIds: [1], fieldIds: [2], lastPlayed: "LAPSED" as const, lastPlayedDays: 30, membership: "MEMBERS" as const, holdoutPercent: 10 };
  const b = createBody(pf, matches, cities);
  eq("players mode sends the ids, the filters at their defaults and nobody held back",
    [b.audienceMode, b.playerIds, b.cityIds, b.fieldIds, b.lastPlayed, "lastPlayedDays" in b, b.membership, b.holdoutPercent], ["PLAYERS", [7, 8], [], [], "ANY", false, "ANYONE", 0]);
  eq("ids are sent in id order, as the backend stores them", createBody({ ...pf, playerIds: [83, 2, 6] }, matches, cities).playerIds, [2, 6, 83]);
  eq("the read-back ignores the order of id sets (a typed order is not NOT APPLIED)", mismatches({ playerIds: [83, 2], fieldIds: [2, 1], name: "x" }, { playerIds: [2, 83], fieldIds: [1, 2], name: "x" }), []);
  eq("...but still catches a real difference (the control)", mismatches({ playerIds: [83, 2], name: "x" }, { playerIds: [2], name: "y" }), ["playerIds", "name"]);
  eq("the live count asks about the same ids", [audienceBody(pf, matches, cities).audienceMode, audienceBody(pf, matches, cities).playerIds], ["PLAYERS", [7, 8]]);
  eq("no ids stops the save", formProblem({ ...pf, playerIds: [] }, matches), "Add at least one player ID.");
  eq("the summary speaks of chosen players, no city", summary(pf, { count: 2, heldBack: 0, players: 2, mostItCanCost: null }, matches, cities, NOW).startsWith("2 chosen players get 50% off one match"), true);
  eq("the list line", audienceText({ ...draftFrom(), audienceMode: "PLAYERS", playerIds: [7, 8, 9] }, cities, []), "3 chosen players");
  const stored = draftFrom({ audienceMode: "PLAYERS", playerIds: [7, 8], cityIds: [], lastPlayed: "ANY", lastPlayedDays: null, holdoutPercent: 0, eyebrow: "JUST FOR YOU", caption: null, body: "Any match. The discount is already on your account." });
  eq("a stored players offer loads and sends nothing", patchBody(stored, formOf(stored, matches, cities), matches, cities), {});
  eq("found and not-found lines", [playerLine({ id: 7, name: "Luis Ortega", city: "Austin", matchesPlayed: 3 }), notFoundLine([99999]), notFoundLine([1, 2])],
    ["Luis Ortega · Austin · 3 matches", "1 ID not found: 99999. It will be skipped.", "2 IDs not found: 1, 2. They will be skipped."]);
}

console.log("uses taken against the limit:");
eq("N of M used when a limit is set", usedOfLimit({ ...results, usesTaken: 10, maxRedemptions: 10 }), "10 of 10 used");
eq("nothing when there is no limit", usedOfLimit({ ...results, usesTaken: 3, maxRedemptions: null }), null);
eq("nothing when the backend sent no usesTaken (the control)", usedOfLimit({ ...results, maxRedemptions: 10 }), null);
eq("the list says it", resultsLines(draftFrom({ state: "LIVE", status: "LAUNCHED", results: { ...results, usesTaken: 38, maxRedemptions: 50 } }))[0], "412 saw · 38 of 50 used");
eq("...and keeps the plain count without a limit", resultsLines(draftFrom({ state: "LIVE", status: "LAUNCHED", results: { ...results, usesTaken: 38, maxRedemptions: null } }))[0], "412 saw · 38 used");

console.log("photo rule:");
eq("an http photo stops the save", formProblem({ ...nowF, name: "x", copy: { photoUrl: "http://covers.local/a.jpg" } }, matches), "The photo must be an https link.");
eq("the local backend's own files pass (seeded covers and local uploads)", [photoUrlOk("http://localhost:3070/dev/uploads/fields/1/cover.png"), photoUrlOk("http://localhost:3070/dev/uploads/offers/photos/a.jpg")], [true, true]);
eq("a spoofed or other local address does not", [photoUrlOk("http://localhost:3070.evil.com/dev/uploads/a.jpg"), photoUrlOk("http://localhost:3000/dev/uploads/a.jpg"), photoUrlOk("http://localhost:3070/other/a.jpg"), photoUrlOk("javascript:alert(1)"), photoUrlOk("offers/photos/a.jpg")], [false, false, false, false, false]);

console.log("photo upload:");
eq("JPG, PNG and WebP, by type or by name when the browser gives no type", [photoContentType({ type: "image/jpeg", name: "a" }), photoContentType({ type: "image/webp", name: "a" }), photoContentType({ type: "", name: "a.PNG" }), photoContentType({ type: "", name: "a.jpeg" })], ["image/jpeg", "image/webp", "image/png", "image/jpeg"]);
eq("anything else is refused, even with a good name", [photoContentType({ type: "image/gif", name: "a.png" }), photoContentType({ type: "", name: "a.gif" })], [null, null]);
eq("exactly 5 MB is fine, a byte more is not, and empty is not", [photoFileProblem({ type: "image/png", name: "a", size: 5242880 }), photoFileProblem({ type: "image/png", name: "a", size: 5242881 }), photoFileProblem({ type: "image/png", name: "a", size: 0 })], [null, "That image is over 5 MB, the most that can be uploaded.", "That file is empty."]);
eq("the wrong type says so", photoFileProblem({ type: "application/pdf", name: "a.pdf", size: 10 }), "Only JPG, PNG or WebP images can be uploaded.");
eq("headers a page may not set are dropped", settableHeaders({ "Content-Type": "image/png", "Content-Length": "9", Host: "x", "If-None-Match": "*" }), [["Content-Type", "image/png"], ["If-None-Match", "*"]]);
const lk = { method: "PUT", fileKey: "k", headers: {}, expiresAt: "" };
const UP = "localhost:3070";
eq("the link must be a PUT to the local backend (the control)", photoLinkProblem({ ...lk, uploadURL: "http://localhost:3070/dev/uploads/offers/photos/a.jpg" }, UP), null);
eq("a spoofed host is refused on the parsed host", photoLinkProblem({ ...lk, uploadURL: "http://localhost:3070.evil.com/a.jpg" }, UP) !== null, true);
eq("another host, a POST and no key are refused", [photoLinkProblem({ ...lk, uploadURL: "https://evil.com/a.jpg" }, UP) !== null, photoLinkProblem({ ...lk, method: "POST", uploadURL: "http://localhost:3070/a" }, UP) !== null, photoLinkProblem({ ...lk, fileKey: "", uploadURL: "http://localhost:3070/a" }, UP) !== null, photoLinkProblem({ ...lk }, UP) !== null], [true, true, true, true]);
{
  const up = [{ url: "https://x/a.jpg", name: "a.jpg" }, { url: "https://x/b.jpg", name: "b.jpg" }];
  eq("uploads stay as tiles", uploadTiles(up, null, []).map((p) => p.url), ["https://x/a.jpg", "https://x/b.jpg"]);
  eq("the saved photo is a tile even if this browser never saw it", uploadTiles(up, "https://x/c.jpg", []).map((p) => p.name), ["a.jpg", "b.jpg", "Saved photo"]);
  eq("a saved photo that is a cover or an upload is not doubled", [uploadTiles(up, "https://x/a.jpg", []).length, uploadTiles([], "https://x/cover.jpg", ["https://x/cover.jpg"]).length], [2, 0]);
  eq("the × takes only that tile off", hideUpload(up, "https://x/a.jpg").map((p) => p.name), ["b.jpg"]);
  eq("the saved photo has no ×, every other upload does", [canHidePhoto("https://x/a.jpg", "https://x/a.jpg"), canHidePhoto("https://x/b.jpg", "https://x/a.jpg"), canHidePhoto("https://x/b.jpg", null)], [false, true, true]);
  eq("a hidden saved-with photo would still be a tile (why it has no ×)", uploadTiles(hideUpload(up, "https://x/a.jpg"), "https://x/a.jpg", []).map((p) => p.url), ["https://x/b.jpg", "https://x/a.jpg"]);
  const A = "https://x/a.jpg", B = "https://x/b.jpg", COVER = "https://covers.local/riverside.jpg";
  eq("a new offer: hiding the selected photo goes to the default", copyOf({ ...nowF, copy: copyAfterHide({ photoUrl: A, headline: "HI" }, A, undefined, null) }, matches, cities).photoUrl, null);
  eq("...and leaves the other typed text alone", copyAfterHide({ photoUrl: A, headline: "HI" }, A, undefined, null), { headline: "HI" });
  eq("...on a specific match the default is its field cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116, copy: copyAfterHide({ photoUrl: A }, A, undefined, COVER) }, matches, cities).photoUrl, COVER);
  eq("hiding a photo that is not selected changes nothing", copyAfterHide({ photoUrl: B }, A, B, null), { photoUrl: B });
  // Saved with A, then B picked and hidden: back to A, nothing to save.
  for (const [name, over] of [["a draft", {}], ["a launched offer", { status: "LAUNCHED", state: "LIVE" }], ["a paused offer", { status: "PAUSED", state: "PAUSED" }]] as const) {
    const c = draftFrom({ photoUrl: A, ...over } as Partial<Campaign>);
    const f = formOf(c, matches, cities);
    const picked = { ...f, copy: { ...f.copy, photoUrl: B } };
    eq(`${name} saved with a photo: picking another sends it (the control)`, patchBody(c, picked, matches, cities), { photoUrl: B });
    const back = { ...picked, copy: copyAfterHide(picked.copy, B, c.photoUrl, null) };
    eq(`${name}: hiding it goes back to the saved photo`, copyOf(back, matches, cities).photoUrl, A);
    eq(`${name}: and leaves nothing to save`, patchBody(c, back, matches, cities), {});
  }
  const none = draftFrom({ photoUrl: null });
  const nf = formOf(none, matches, cities);
  const nb = { ...nf, copy: copyAfterHide({ ...nf.copy, photoUrl: B }, B, null, null) };
  eq("saved with no photo: hiding goes to the default, nothing to save", [copyOf(nb, matches, cities).photoUrl, patchBody(none, nb, matches, cities)], [null, {}]);
  eq("...and the offer still follows the deal, it is not pinned", "photoUrl" in nb.copy, false);
  // Saved with no photo, on a specific match whose default is a cover: back to no photo, not the cover.
  const sc = draftFrom({ photoUrl: null, matchIds: [116], matchScoped: true, buttonTarget: "MATCH", buttonMatchId: 116, usesPerPlayer: 1, endsLocal: "2026-11-02 19:00:00" });
  const sf = formOf(sc, matches, cities);
  const sb = { ...sf, copy: copyAfterHide({ ...sf.copy, photoUrl: B }, B, null, COVER) };
  eq("saved with no photo where the default is a cover: back to saved, not the cover", [copyOf(sb, matches, cities).photoUrl, patchBody(sc, sb, matches, cities).photoUrl], [null, undefined]);
  // Another unsaved edit is still there to save; hiding only removes its own.
  const edited = draftFrom({ photoUrl: A });
  const ef = { ...formOf(edited, matches, cities), name: "New name" };
  eq("an unrelated unsaved edit survives hiding", patchBody(edited, { ...ef, copy: copyAfterHide({ ...ef.copy, photoUrl: B }, B, A, null) }, matches, cities), { name: "New name" });
  eq("a stored local photo saves", formProblem({ ...nowF, name: "x", copy: { photoUrl: "http://localhost:3070/dev/uploads/offers/photos/a.jpg" } }, matches), null);
}
eq("an https photo is fine (the control)", formProblem({ ...nowF, name: "x", copy: { photoUrl: "https://covers.local/a.jpg" } }, matches), null);

console.log("optional sections of the popup:");
{
  eq("the four removable sections, and not the required ones", [REMOVABLE_KEYS, isRemovable("headline"), isRemovable("buttonLabel"), isRemovable("dismissLabel"), isRemovable("photoUrl")], [["eyebrow", "caption", "line", "body"], false, false, false, false]);
  const base = { ...nowF, name: "x", lastPlayed: "LAPSED" as const, lastPlayedDays: 30 };
  const auto = autoCopy(base, matches, cities);
  const gone = (["eyebrow", "caption", "line", "body"] as const).reduce((cp, k) => removeSection(cp, k), base.copy);
  const created = createBody({ ...base, copy: gone }, matches, cities);
  eq("creating with all four removed sends null for each, not their absence", [created.eyebrow, created.caption, created.line, created.body], [null, null, null, null]);
  eq("the control: created untouched they carry the deal's text", (["eyebrow", "caption", "line", "body"] as const).map((k) => createBody(base, matches, cities)[k]), [auto.eyebrow, auto.caption, auto.line, auto.body]);
  eq("other nulls are still left out of a create", ["photoUrl" in created, "maxRedemptions" in created, "maxMatches" in created], [false, false, false]);
  const removedKeys = copyOf({ ...base, copy: gone }, matches, cities);
  eq("removed reads as null for the preview, required text stays", [removedKeys.eyebrow, removedKeys.caption, removedKeys.line, removedKeys.body, removedKeys.headline, removedKeys.buttonLabel], [null, null, null, null, auto.headline, auto.buttonLabel]);
  eq("headline and button can't be made null", (({ headline, buttonLabel }) => [headline, buttonLabel])(copyOf({ ...base, copy: { headline: null, buttonLabel: null } }, matches, cities)), [auto.headline, auto.buttonLabel]);
  eq("the dismiss link emptied is the deal's text, never null", copyOf({ ...base, copy: { dismissLabel: " " } }, matches, cities).dismissLabel, "Not now");
  eq("a removed section stays removed when the deal changes", copyOf({ ...base, dealAmount: 40, copy: gone }, matches, cities).eyebrow, null);
  eq("the headline still follows that deal change", copyOf({ ...base, dealAmount: 40, copy: gone }, matches, cities).headline, "40% OFF");
  eq("an optional box emptied by hand saves as null, like Remove", createBody({ ...base, copy: { body: "  " } }, matches, cities).body, null);

  for (const [name, status] of [["draft", "DRAFT"], ["launched", "LAUNCHED"], ["paused", "PAUSED"]] as const) {
    const c = draftFrom({ status, state: status === "DRAFT" ? "DRAFT" : status === "PAUSED" ? "PAUSED" : "LIVE" });
    const f = formOf(c, matches, cities);
    const cut = { ...f, copy: removeSection(f.copy, "body") };
    eq(`${name}: Remove sends null for that section alone`, patchBody(c, cut, matches, cities), { body: null });
    const saved = { ...c, body: null };
    const sf = formOf(saved, matches, cities);
    eq(`${name}: a saved removal loads removed and sends nothing`, [sf.copy.body, sectionCollapsed(sf.copy, "body", autoCopy(sf, matches, cities).body), patchBody(saved, sf, matches, cities)], [null, true, {}]);
    eq(`${name}: + Add on a saved removal sends the suggested text`, patchBody(saved, { ...sf, copy: addSection(sf.copy, "body", undefined, autoCopy(sf, matches, cities).body) }, matches, cities), { body: "Any match in Austin. The discount is already on your account." });
    eq(`${name}: Remove then + Add on the same visit leaves nothing to save`, patchBody(c, { ...cut, copy: addSection(cut.copy, "body", undefined, auto.body) }, matches, cities), {});
  }

  const typed = draftFrom({ eyebrow: "HEY THERE", status: "LAUNCHED", state: "LIVE" });
  const tf = formOf(typed, matches, cities);
  eq("typed text is the control: it loads as typed", tf.copy.eyebrow, "HEY THERE");
  const cutT = removeSection(tf.copy, "eyebrow");
  eq("Remove then + Add brings typed text back, nothing to save", patchBody(typed, { ...tf, copy: addSection(cutT, "eyebrow", "HEY THERE", auto.eyebrow) }, matches, cities), {});
  eq("Reset to suggested is offered on typed text", canReset(tf.copy, "eyebrow", auto.eyebrow), true);
  eq("Reset to suggested sends the deal's text after launch", patchBody(typed, { ...tf, copy: resetCopy(tf.copy, "eyebrow") }, matches, cities), { eyebrow: auto.eyebrow });
  eq("not offered when following the deal, or on the suggestion itself", [canReset({}, "eyebrow", auto.eyebrow), canReset({ eyebrow: auto.eyebrow }, "eyebrow", auto.eyebrow)], [false, false]);
  eq("not offered with nothing to suggest", canReset({ caption: "typed" }, "caption", null), false);
  eq("offered on an emptied required field", canReset({ headline: "" }, "headline", "50% OFF"), true);

  // The photo line is the one section a deal can leave empty.
  const any = { ...nowF, name: "x" };
  eq("an any-match offer suggests no photo line, so it starts collapsed", [autoCopy(any, matches, cities).caption, sectionCollapsed(any.copy, "caption", null)], [null, true]);
  const opened = addSection(any.copy, "caption", undefined, null);
  eq("+ Add photo line opens an empty box", [opened.caption, sectionCollapsed(opened, "caption", null)], ["", false]);
  eq("left empty it still saves as null", "caption" in createBody({ ...any, copy: opened }, matches, cities) && createBody({ ...any, copy: opened }, matches, cities).caption === null, true);
  eq("with text typed it is sent", createBody({ ...any, copy: { caption: "See you there" } }, matches, cities).caption, "See you there");
  eq("a section with text is not collapsed (the control)", sectionCollapsed({}, "eyebrow", "JUST FOR YOU"), false);
  eq("button label empty stops the save", formProblem({ ...any, copy: { buttonLabel: "" } }, matches), "The popup needs a button label.");
  eq("all four removed saves (the control)", formProblem({ ...any, copy: gone }, matches), null);
}

console.log("a saved draft when the deal, audience or match changes:");
{
  const stored = (over: Partial<Campaign> = {}, form: Partial<typeof nowF> = {}) => {
    const body = createBody({ ...nowF, name: "x", cityIds: [1], ...form }, matches, cities);
    return { lastPlayedDays: null, maxMatches: null, maxRedemptions: null, buttonMatchId: null, photoUrl: null, matchIds: [], playerIds: [], fieldIds: [], ...body, id: 9, matchScoped: false, status: "DRAFT", state: "DRAFT", results, ...over } as unknown as Campaign;
  };
  const lapse = { lastPlayed: "LAPSED" as const, lastPlayedDays: 30 };
  const pick = { scope: "MATCH" as const, matchId: 116, fieldIds: [1], endsLocal: "2026-11-02 19:00:00" };

  const c = stored();
  const f = formOf(c, matches, cities);
  eq("50% to 40% updates an untouched headline", copyOf({ ...f, dealAmount: 40 }, matches, cities).headline, "40% OFF");
  eq("...and sends it with the deal", patchBody(c, { ...f, dealAmount: 40 }, matches, cities), { dealAmount: 40, headline: "40% OFF" });
  eq("an untouched section is not warned about", staleSections({ ...f, dealAmount: 40 }, writtenForOnLoad(f, {}, matches, cities), "DRAFT", matches, cities), []);
  eq("an untouched body follows the city", copyOf({ ...f, cityIds: [2] }, matches, cities).body, "Any match in Houston. The discount is already on your account.");
  eq("an untouched button label follows a picked match", copyOf({ ...f, ...pick }, matches, cities).buttonLabel, "Join this match");
  eq("an untouched photo follows a picked match", copyOf({ ...f, ...pick }, matches, cities).photoUrl, "https://covers.local/riverside.jpg");
  eq("the button target follows a picked match", [buttonOf({ ...f, ...pick }, matches).target, buttonOf({ ...f, ...pick }, matches).matchId], ["MATCH", 116]);
  const scoped = stored({ buttonTarget: "MATCH", buttonMatchId: 116, matchIds: [116], matchScoped: true }, pick);
  const sf = formOf(scoped, matches, cities);
  eq("a saved match offer loads with that button and sends nothing", [buttonOf(sf, matches).matchId, patchBody(scoped, sf, matches, cities)], [116, {}]);
  const anyAgain = { ...sf, scope: "ANY" as const, matchId: null };
  eq("moved to any match, the button goes back to Find a match, not the old match", [buttonOf(anyAgain, matches).target, buttonOf(anyAgain, matches).matchId], ["FIND_MATCH", null]);
  eq("...and that is sent", (({ buttonTarget, buttonMatchId, buttonLabel }) => [buttonTarget, buttonMatchId, buttonLabel])(patchBody(scoped, anyAgain, matches, cities)), ["FIND_MATCH", null, "Find a match"]);
  const picked = stored({ buttonTarget: "MATCH", buttonMatchId: 117 });
  eq("a button someone pointed at a match on an any-match offer stays (the control)", [buttonOf({ ...formOf(picked, matches, cities), dealAmount: 40 }, matches).matchId], [117]);

  // The case that started this: saved with no photo line, reopened, then the audience or the match changes.
  const noLine = stored({}, { copy: { caption: null } });
  const nf = formOf(noLine, matches, cities);
  for (const [name, change] of [["audience changed to lapsed", lapse], ["a specific match picked", pick]] as const) {
    const moved = { ...nf, ...change };
    const offered = autoCopy(moved, matches, cities).caption;
    eq(`${name}: the deal does suggest a photo line now (the control)`, offered === null, false);
    eq(`${name}: the photo line stays removed`, [copyOf(moved, matches, cities).caption, sectionCollapsed(moved.copy, "caption", offered)], [null, true]);
    eq(`${name}: no photo line is sent`, "caption" in patchBody(noLine, moved, matches, cities), false);
    eq(`${name}: + Add brings the suggestion back by hand`, copyOf({ ...moved, copy: addSection(moved.copy, "caption", undefined, offered) }, matches, cities).caption, offered);
  }
  const cutAll = stored({}, { lastPlayed: "LAPSED", lastPlayedDays: 30, copy: { eyebrow: null, caption: null, line: null, body: null } });
  const cf = formOf(cutAll, matches, cities);
  eq("all four removed stay removed through a deal, audience and match change",
    (({ eyebrow, caption, line, body }) => [eyebrow, caption, line, body])(copyOf({ ...cf, dealAmount: 40, lastPlayed: "ANY", lastPlayedDays: null, ...pick }, matches, cities)), [null, null, null, null]);

  // Typed text.
  const typed = stored({ headline: "HALF OFF" });
  const tf = formOf(typed, matches, cities);
  const w = writtenForOnLoad(tf, {}, matches, cities);
  eq("typed text loads as written for the deal it was saved with", w, { headline: "50% OFF" });
  eq("a typed headline with the deal unchanged has no warning (the control)", staleSections(tf, w, "DRAFT", matches, cities), []);
  const t40 = { ...tf, dealAmount: 40 };
  eq("a typed headline stays when the deal changes", copyOf(t40, matches, cities).headline, "HALF OFF");
  eq("...and only the deal is sent", patchBody(typed, t40, matches, cities), { dealAmount: 40 });
  eq("...and it gets the warning", staleSections(t40, w, "DRAFT", matches, cities), ["headline"]);
  eq("...with the Reset link", canReset(t40.copy, "headline", autoCopy(t40, matches, cities).headline), true);
  eq("Reset takes the new suggestion and the warning goes", [copyOf({ ...t40, copy: resetCopy(t40.copy, "headline") }, matches, cities).headline, staleSections({ ...t40, copy: resetCopy(t40.copy, "headline") }, w, "DRAFT", matches, cities)], ["40% OFF", []]);
  eq("the warning survives a save and a reopen, from what the browser kept", staleSections(formOf({ ...typed, dealAmount: 40 }, matches, cities), writtenForOnLoad(formOf({ ...typed, dealAmount: 40 }, matches, cities), w, matches, cities), "DRAFT", matches, cities), ["headline"]);
  eq("in a browser that kept nothing it counts as written for the deal it loads with", staleSections(formOf({ ...typed, dealAmount: 40 }, matches, cities), writtenForOnLoad(formOf({ ...typed, dealAmount: 40 }, matches, cities), {}, matches, cities), "DRAFT", matches, cities), []);
  eq("going back to the old deal clears it", staleSections({ ...t40, dealAmount: 50 }, w, "DRAFT", matches, cities), []);
  eq("typing again for the new deal clears it", staleSections(t40, { ...w, headline: "40% OFF" }, "DRAFT", matches, cities), []);
  eq("typing the new suggestion by hand clears it", staleSections({ ...t40, copy: { ...t40.copy, headline: "40% OFF" } }, w, "DRAFT", matches, cities), []);
  eq("typing the suggestion itself goes back to following", copyOf({ ...tf, dealAmount: 40, copy: copyAfterType(tf.copy, "headline", "50% OFF", "50% OFF") }, matches, cities).headline, "40% OFF");
  eq("an emptied section has nothing to warn about", staleSections({ ...t40, copy: { body: "" } }, { body: "x" }, "DRAFT", matches, cities), []);
  const tc = stored({ caption: "See you there" });
  const tcf = formOf(tc, matches, cities);
  eq("typed photo line, match picked: warned, though there was no suggestion before", staleSections({ ...tcf, ...pick }, writtenForOnLoad(tcf, {}, matches, cities), "DRAFT", matches, cities), ["caption"]);
  eq("a photo is never in the warning", staleSections({ ...formOf(stored({ photoUrl: "https://covers.local/a.jpg" }), matches, cities), ...pick }, { photoUrl: null }, "DRAFT", matches, cities), []);

  // The Launch confirm.
  eq("Launch confirm lists nothing with no warning showing", staleLines(staleSections(tf, w, "DRAFT", matches, cities), tf), []);
  eq("Launch confirm lists the section when a warning is showing", staleLines(staleSections(t40, w, "DRAFT", matches, cities), t40), ["Headline: HALF OFF"]);
  eq("a new, unsaved offer gets the same warning", staleSections({ ...nowF, dealAmount: 40, copy: { headline: "HALF OFF" } }, { headline: "50% OFF" }, null, matches, cities), ["headline"]);

  // Launched: the deal is locked, and old text is not raised.
  for (const status of ["LAUNCHED", "PAUSED", "ENDED"] as const) eq(`${status}: no warning, whatever the browser kept`, staleSections(t40, w, status, matches, cities), []);
  const live = stored({ headline: "HALF OFF", status: "LAUNCHED", state: "LIVE" });
  eq("launched: a locked deal change sends nothing and moves no text", patchBody(live, { ...formOf(live, matches, cities), dealAmount: 40 }, matches, cities), {});
}

console.log("money, in cents, as the backend\'s applyOfferDeal:");
eq("50% of $15", priceWithDeal(1500, "PERCENT_OFF", 50), 750);
eq("$5 off $9", priceWithDeal(900, "AMOUNT_OFF", 500), 400);
eq("$5 off $5.40 leaves 40 cents, which is free", priceWithDeal(540, "AMOUNT_OFF", 500), 0);
eq("set price $5", priceWithDeal(1500, "SET_PRICE", 500), 500);
eq("priceWithDeal alone returns the set price, even above normal (like the backend's applyOfferDeal; at a join a cheaper match keeps its price and the offer isn't used)", priceWithDeal(900, "SET_PRICE", 1200), 1200);
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

console.log("extra bookings:");
{
  const at = (wP: number, wB: number, hP: number, hB: number, discount: number) => ({ ...results, discountGiven: discount,
    booked: { withOffer: { players: wP, booked: wB, rate: wP ? wB / wP : null }, heldBack: { players: hP, booked: hB, rate: hP ? hB / hP : null } } });
  // 37 x (10/37 - 4/40) = 10 - 3.7 = 6.3, so 6; $54 / 6 = $9.
  eq("N and X", extraBookingsLine(at(37, 10, 40, 4, 5400)), "About 6 extra bookings · $9 in discounts per extra booking");
  // 100 x (0.2 - 0.1) = 10; $25 / 10 = $2.50, which rounds to the dollar.
  eq("X rounds to the dollar", extraBookingsLine(at(100, 20, 30, 3, 2500)), "About 10 extra bookings · $3 in discounts per extra booking");
  eq("one extra booking is singular", extraBookingsLine(at(10, 2, 30, 3, 1000)), "About 1 extra booking · $10 in discounts per extra booking");
  eq("the same rate is no extra bookings, and no cost", extraBookingsLine(at(100, 10, 30, 3, 5000)), "No extra bookings so far");
  eq("a worse rate than held back is no extra bookings", extraBookingsLine(at(100, 5, 30, 3, 5000)), "No extra bookings so far");
  eq("an N that rounds to 0 is no extra bookings, not a divide by zero", extraBookingsLine(at(10, 1, 30, 2, 5000)), "No extra bookings so far");
  eq("exactly 30 held back shows it", extraBookingsLine(at(100, 20, 30, 3, 1000)) !== null, true);
  eq("29 held back hides it", extraBookingsLine(at(100, 20, 29, 3, 1000)), null);
  eq("the fixture's 3 held back hides it", extraBookingsLine(at(37, 10, 3, 1, 5400)), null);
  eq("Specific players with a holdout compares like any other (2026-11-02: lists of 200+ hold back)", extraBookingsLine(at(100, 20, 40, 3, 1000)) !== null, true);
  eq("no rate for the offer group hides it", extraBookingsLine(at(0, 0, 40, 3, 0)), null);
}

console.log("access:");

eq("a 401 is an ended sign-in, not a 404", offersAccessState(401, { error: "Invalid session" }), "signin");
eq("a 200 yes is yes (the control)", offersAccessState(200, { allowed: true }), "yes");
eq("off the list, not an admin, local mode off and a strange 200 are all no",
  [offersAccessState(404, { error: "Not found" }), offersAccessState(403, { error: "x" }), offersAccessState(503, { error: "x" }), offersAccessState(200, { allowed: "yes" }), offersAccessState(200, null)], ["no", "no", "no", "no", "no"]);


// ── THE SERVER CONFIG: env-driven, fails closed ──────────────────────────────────────────────────
const LOCAL_ON = { MATCHDAY_LOCAL_API: "1", NODE_ENV: "development" };
const goodLocal = { ...LOCAL_ON, OFFERS_ENV: "local", OFFERS_API_BASE_URL: "http://localhost:3070", OFFERS_UPLOAD_HOST: "localhost:3070", MATCHDAY_LOCAL_API_EMAIL: "a@x.y", MATCHDAY_LOCAL_API_PASSWORD: "p" };
const goodProd = { NODE_ENV: "production", OFFERS_ENV: "production", OFFERS_API_BASE_URL: "https://playmatchday.herokuapp.com", OFFERS_UPLOAD_HOST: "bucket.s3.amazonaws.com", MATCHDAY_PROD_BASE_URL: "https://playmatchday.herokuapp.com", MATCHDAY_PROD_API_EMAIL: "a@x.y", MATCHDAY_PROD_API_PASSWORD: "p" };
const goodStage = { NODE_ENV: "production", OFFERS_ENV: "staging", OFFERS_API_BASE_URL: "https://matchday-stage.herokuapp.com", OFFERS_UPLOAD_HOST: "b.s3.amazonaws.com", MATCHDAY_STAGE_API_BASE_URL: "https://matchday-stage.herokuapp.com", MATCHDAY_STAGE_API_EMAIL: "a@x.y", MATCHDAY_STAGE_API_PASSWORD: "p" };
const cfgOk = (e: Record<string, string | undefined>) => readOffersConfig(e).ok;
eq("local, all set: open (the control)", readOffersConfig(goodLocal), { ok: true, config: { env: "local", baseUrl: "http://localhost:3070", uploadHost: "localhost:3070" } });
eq("production, all set: open (the control)", readOffersConfig(goodProd), { ok: true, config: { env: "production", baseUrl: "https://playmatchday.herokuapp.com", uploadHost: "bucket.s3.amazonaws.com" } });
eq("staging, all set: open (the control)", cfgOk(goodStage), true);
for (const [good, keys] of [[goodProd, ["MATCHDAY_PROD_BASE_URL", "MATCHDAY_PROD_API_EMAIL", "MATCHDAY_PROD_API_PASSWORD"]], [goodStage, ["MATCHDAY_STAGE_API_BASE_URL", "MATCHDAY_STAGE_API_EMAIL", "MATCHDAY_STAGE_API_PASSWORD"]], [goodLocal, ["MATCHDAY_LOCAL_API_EMAIL", "MATCHDAY_LOCAL_API_PASSWORD"]]] as const) {
  for (const k of keys) {
    const r = readOffersConfig({ ...good, [k]: undefined }) as { ok: boolean; problem: string };
    eq(`${k} missing: closed, and the problem names it`, [r.ok, r.problem.includes(k)], [false, true]);
    eq(`${k} blank: closed`, cfgOk({ ...good, [k]: "  " }), false);
  }
}
eq("production's credentials don't open staging, or staging's production", [cfgOk({ ...goodStage, MATCHDAY_STAGE_API_EMAIL: undefined, MATCHDAY_PROD_API_EMAIL: "a@x.y" }), cfgOk({ ...goodProd, MATCHDAY_PROD_API_EMAIL: undefined, MATCHDAY_STAGE_API_EMAIL: "a@x.y" })], [false, false]);
eq("a credentials base on another host: closed", cfgOk({ ...goodProd, MATCHDAY_PROD_BASE_URL: "https://matchday-stage.herokuapp.com" }), false);
eq("no password's value in any problem", JSON.stringify(readOffersConfig({ ...goodProd, MATCHDAY_PROD_API_EMAIL: undefined, MATCHDAY_PROD_API_PASSWORD: "hunter2" })).includes("hunter2"), false);
eq("nothing set: closed", cfgOk({}), false);
for (const k of ["OFFERS_ENV", "OFFERS_API_BASE_URL", "OFFERS_UPLOAD_HOST"] as const) {
  eq(`${k} unset: closed, on local and on production`, [cfgOk({ ...goodLocal, [k]: undefined }), cfgOk({ ...goodProd, [k]: undefined })], [false, false]);
  eq(`${k} empty: closed`, cfgOk({ ...goodProd, [k]: "" }), false);
}
eq("an unknown OFFERS_ENV: closed", cfgOk({ ...goodProd, OFFERS_ENV: "prod" }), false);
eq("local with local mode off (a deployed server): closed", cfgOk({ ...goodLocal, MATCHDAY_LOCAL_API: undefined }), false);
eq("production with local mode on: closed", cfgOk({ ...goodProd, ...LOCAL_ON }), false);
eq("staging's URL for production, and production's for local: closed", [cfgOk({ ...goodProd, OFFERS_API_BASE_URL: "https://matchday-stage.herokuapp.com" }), cfgOk({ ...goodLocal, OFFERS_API_BASE_URL: "https://playmatchday.herokuapp.com" })], [false, false]);
eq("a spoofed base host: closed", cfgOk({ ...goodProd, OFFERS_API_BASE_URL: "https://playmatchday.herokuapp.com.evil.com" }), false);
eq("http on production: closed", cfgOk({ ...goodProd, OFFERS_API_BASE_URL: "http://playmatchday.herokuapp.com" }), false);
eq("a base with a path: closed", cfgOk({ ...goodProd, OFFERS_API_BASE_URL: "https://playmatchday.herokuapp.com/api" }), false);
eq("an upload host that is a URL, a wildcard or has a path: closed",
  ["https://bucket.s3.amazonaws.com", "*.amazonaws.com", "bucket.s3.amazonaws.com/x", "user@bucket.com"].map((h) => cfgOk({ ...goodProd, OFFERS_UPLOAD_HOST: h })), [false, false, false, false]);
eq("the problem names the variable, never a value", (readOffersConfig({ ...goodProd, OFFERS_API_BASE_URL: "https://secret.example.com" }) as { problem: string }).problem.includes("secret"), false);
const S3 = "bucket.s3.amazonaws.com";
eq("a link on the configured upload host passes", photoLinkProblem({ ...lk, uploadURL: `https://${S3}/offers/a.jpg` }, S3), null);
eq("with S3 configured, the local backend and a spoof are refused", [photoLinkProblem({ ...lk, uploadURL: "http://localhost:3070/a" }, S3) !== null, photoLinkProblem({ ...lk, uploadURL: `https://${S3}.evil.com/a` }, S3) !== null], [true, true]);
// The write client's own guard still stands behind the config (local mode is off under this suite).
eq("the production base passes the client's host guard, an Offers write passes preflight", (() => { assertAllowedHost("production", "https://playmatchday.herokuapp.com/admin/offers/campaigns"); preflightWrite("production", "POST", "https://playmatchday.herokuapp.com/admin/offers/campaigns", { name: "x", playerIds: [1] }); return "through"; })(), "through");


// ── THE MATCH LIST (GET admin/offers/matches) ────────────────────────────────────────────────────
{
  const api = { id: 5, name: "Thu", startsLocal: "2026-11-02 19:00:00", fieldId: 3, fieldName: "NEMP", cityId: 1, price: 900, playersIn: 11, capacity: 16, minimum: 14 };
  eq("a row maps across, wall clock untouched", offerMatchOpt(api), { id: 5, name: "Thu", startLocal: "2026-11-02 19:00:00", fieldId: 3, fieldTitle: "NEMP", fieldCover: null, cityId: 1, price: 900, players: 11, maxPlayers: 16, minPlayers: 14, upcoming: true });
  eq("no cap reads as no cap", [fillText(offerMatchOpt({ ...api, capacity: null })), fillFraction(offerMatchOpt({ ...api, capacity: null }))], ["11 · needs 3", 0]);
  const fields = [{ id: 3, title: "NEMP", cityId: 1, cover: "https://c/n.jpg" }];
  eq("the cover comes from the field, so the suggested photo doesn't change with the read", withCovers([offerMatchOpt(api)], fields)[0].fieldCover, "https://c/n.jpg");
  eq("a field with no cover stays none (the control)", withCovers([offerMatchOpt({ ...api, fieldId: 9 })], fields)[0].fieldCover, null);
  const saved = draftFrom({ matchIds: [5], matchScoped: true, photoUrl: "https://c/n.jpg" });
  const withCover = withCovers([offerMatchOpt(api)], fields);
  eq("a saved match offer with its cover is not a change", patchBody(saved, formOf(saved, withCover, cities), withCover, cities).photoUrl, undefined);
  eq("later lists win, and nothing doubles", mergeMatches([offerMatchOpt(api)], [offerMatchOpt({ ...api, playersIn: 12 })]).map((m) => [m.id, m.players]), [[5, 12]]);
  eq("the range is today and the next 13 days, across a month", pickerRange("2026-10-30 23:59:00"), { from: "2026-10-30", to: "2026-11-12" });
  // FIELD COVERS (1.88): the match's own resolved cover, and every cover as a tile.
  const chosen = { ...api, coverUrl: "https://c/tournament.jpg" };
  eq("a match's resolved cover (coverUrl) is its photo, and the field's Default doesn't replace it", [offerMatchOpt(chosen).fieldCover, withCovers([offerMatchOpt(chosen)], fields)[0].fieldCover], ["https://c/tournament.jpg", "https://c/tournament.jpg"]);
  eq("...and it is the suggested photo for a specific-match offer", copyOf({ ...newForm("2026-11-02 12:00:00"), scope: "MATCH", matchId: 5 }, withCovers([offerMatchOpt(chosen)], fields), cities).photoUrl, "https://c/tournament.jpg");
  eq("an older backend without coverUrl still gets the field's Default (the control)", copyOf({ ...newForm("2026-11-02 12:00:00"), scope: "MATCH", matchId: 5 }, withCovers([offerMatchOpt(api)], fields), cities).photoUrl, "https://c/n.jpg");
  const withExtras = [
    { id: 3, title: "NEMP", cityId: 1, cover: "https://c/n.jpg", covers: [{ id: null, name: "Default", url: "https://c/n.jpg" }, { id: 7, name: "Tournament nights", url: "https://c/tournament.jpg" }] },
    { id: 4, title: "Parmer", cityId: 2, cover: null, covers: [{ id: 9, name: "Lights", url: "https://c/p.jpg" }] },
    { id: 5, title: "Old backend", cityId: 1, cover: "https://c/o.jpg" },
  ];
  eq("tiles: every cover, the Default first, names after the field; a field from an older backend gives its Default", coverTiles(withExtras, []).map((t) => [t.key, t.title, t.url]), [
    ["field-3", "NEMP", "https://c/n.jpg"], ["field-3-cover-7", "NEMP · Tournament nights", "https://c/tournament.jpg"], ["field-4-cover-9", "Parmer · Lights", "https://c/p.jpg"], ["field-5", "Old backend", "https://c/o.jpg"]]);
  eq("...only the offer's cities when it has some", coverTiles(withExtras, [2]).map((t) => t.key), ["field-4-cover-9"]);
}

// ── THE MATCH PICKER ─────────────────────────────────────────────────────────────────────────────
{
  const row = (id: number, startLocal: string, over: Partial<MatchOpt> = {}): MatchOpt => ({ id, name: `M${id}`, startLocal, fieldId: id, fieldTitle: `Field ${id}`, fieldCover: null, cityId: 1, price: 900, players: 5, maxPlayers: 16, minPlayers: 14, upcoming: true, ...over });
  const NOWP = "2026-10-30 14:00:00"; // a Friday
  const list = [
    row(3, "2026-10-31 18:00:00", { fieldTitle: "Round Rock" }),
    row(1, "2026-10-30 19:00:00", { fieldTitle: "NEMP Field 2", players: 11, minPlayers: 14, maxPlayers: 16 }),
    row(2, "2026-10-30 20:30:00", { fieldTitle: "Mueller Park", players: 14, minPlayers: 14 }),
    row(4, "2026-11-05 19:00:00", { fieldTitle: "Last Day Of Seven" }),
    row(5, "2026-11-06 19:00:00", { fieldTitle: "Day Eight" }),
    row(6, "2026-11-12 19:00:00", { fieldTitle: "Day Fourteen" }),
    row(7, "2026-11-13 19:00:00", { fieldTitle: "Day Fifteen" }),
    row(8, "2026-10-30 19:00:00", { cityId: 2, fieldTitle: "Houston Field" }),
    row(9, "2026-10-30 09:00:00", { upcoming: false, fieldTitle: "Already Started" }),
  ];
  const v = (f: Partial<Parameters<typeof pickerView>[1]> = {}) => pickerView(list, { search: "", days: 7, needsPlayers: true, cityIds: [1], ...f }, NOWP, cities);
  const ids = (x: ReturnType<typeof pickerView>) => x.groups.flatMap((g) => g.rows.map((r) => r.match.id));
  eq("next 7 days, needs players, soonest first, one city: not the full match, not day 8, not another city, not started", ids(v()), [1, 3, 4]);
  eq("grouped by day, today marked", v().groups.map((g) => g.label), ["TODAY · FRI OCT 30", "SAT OCT 31", "THU NOV 5"]);
  eq("the footer counts what's shown of everything in those days", v().footer, "Showing 3 of 4 Austin matches in the next 7 days");
  eq("Needs players off shows the full match too", ids(v({ needsPlayers: false })), [1, 2, 3, 4]);
  eq("next 14 days reaches day 14 and stops", ids(v({ days: 14 })), [1, 3, 4, 5, 6]);
  eq("no city chosen: every city", ids(v({ cityIds: [] })), [1, 8, 3, 4]);
  eq("search by field", ids(v({ search: "nemp" })), [1]);
  eq("search by the match's name", ids(v({ search: "m4" })), [4]);
  eq("name and field together", ids(v({ search: "m3 round" })), [3]);
  eq("not by time or day", [ids(v({ search: "6:00" })), ids(v({ search: "sat" }))], [[], []]);
  eq("a search with no match shows none, and says so in the footer", [ids(v({ search: "zzz" })), v({ search: "zzz" }).footer], [[], "Showing 0 of 4 Austin matches in the next 7 days"]);
  eq("the row's time is wall clock, not re-shifted", v().groups[0].rows[0].time, "7:00 PM");
  eq("fill text as the mock", fillText({ players: 11, maxPlayers: 16, minPlayers: 14 }), "11/16 · needs 3");
  eq("fill text with enough, and full", [fillText({ players: 14, maxPlayers: 16, minPlayers: 14 }), fillText({ players: 16, maxPlayers: 16, minPlayers: 14 })], ["14/16", "16/16 · full"]);
  eq("the bar never leaves its track", [fillFraction({ players: 20, maxPlayers: 16 }), fillFraction({ players: 3, maxPlayers: 0 })], [1, 0]);
  eq("a day label is not today's tomorrow", pickerDayLabel("2026-10-31 00:30:00", NOWP), "SAT OCT 31");
}
eq("an offer names its match and its button's match, once each", namedMatchIds({ matchIds: [116], buttonMatchId: 116 }), [116]);
eq("...and two different ones, and none", [namedMatchIds({ matchIds: [116], buttonMatchId: 117 }), namedMatchIds({ matchIds: [], buttonMatchId: null })], [[116, 117], []]);

// ── SET PRICE ────────────────────────────────────────────────────────────────────────────────────
{
  const sp = (dealAmount: number, over = {}) => ({ ...nowF, name: "x", dealType: "SET_PRICE" as const, dealAmount, ...over });
  const one = { scope: "MATCH" as const, matchId: 116, endsLocal: "2026-11-02 19:00:00" }; // normally $15
  eq("under $1 is refused, on any match and on one", [formProblem(sp(99), matches), formProblem(sp(99, one), matches)], ["A set price must be at least $1.", "A set price must be at least $1."]);
  eq("$1 exactly is fine (the control)", formProblem(sp(100), matches), null);
  eq("0 and fractions of a cent are refused", [setPriceProblem({ dealType: "SET_PRICE", dealAmount: 0 }, null) !== null, setPriceProblem({ dealType: "SET_PRICE", dealAmount: 150.5 }, null) !== null], [true, true]);
  eq("one match, above its normal price: blocked", formProblem(sp(1600, one), matches), "That is above this match's normal $15. Set it at or below that.");
  eq("one match, at its normal price: not blocked", formProblem(sp(1500, one), matches), null);
  eq("one match, under it: not blocked (the control)", formProblem(sp(1400, one), matches), null);
  eq("any match, above the cheapest: saves, with a warning", [formProblem(sp(1000), matches), setPriceAnyWarning(sp(1000), matches)], [null, "$10 is above the normal price of some matches here (as low as $9). On those, players pay the normal price and the offer isn't used."]);
  eq("any match, at or under the cheapest: no warning", [setPriceAnyWarning(sp(900), matches), setPriceAnyWarning(sp(500), matches)], [null, null]);
  eq("the warning looks only at those cities", setPriceAnyWarning(sp(1000, { cityIds: [2] }), matches), null);
  eq("one match gets the block, not the any-match warning", setPriceAnyWarning(sp(1600, one), matches), null);
  eq("other deals: neither", [formProblem({ ...nowF, name: "x", dealAmount: 5000 }, matches), setPriceAnyWarning({ ...nowF, name: "x", dealAmount: 5000 }, matches)], [null, null]);
  eq("after launch the deal is locked, so the rule can't stop saving its name", [formProblem(sp(1600, one), matches, "LAUNCHED"), formProblem(sp(1600, one), matches, "PAUSED"), formProblem(sp(1600, one), matches, "DRAFT") !== null], [null, null, true]);
}

// ── THE END TIME AND THE LABELS ──────────────────────────────────────────────────────────────────
{
  const past = "2026-10-28 17:00:00";
  eq("an end in the past stops a launch", launchProblem({ endsLocal: past }, NOW), "The end time has already passed. Pick a later end.");
  eq("an end earlier today stops a launch", launchProblem({ endsLocal: "2026-10-29 14:00:00" }, NOW) !== null, true);
  eq("an end exactly now stops a launch", endHasPassed(NOW, NOW), true);
  eq("an end a minute away doesn't (the control)", launchProblem({ endsLocal: "2026-10-29 14:31:00" }, NOW), null);
  const cnt = { count: 3, heldBack: 0, players: 3, mostItCanCost: null };
  const line = (endsLocal: string, over = {}) => summary({ ...nowF, name: "x", endsLocal, ...over }, cnt, matches, cities, NOW);
  eq("the summary says a past end has passed, never a weekday that reads as coming", line(past).includes("until Wed, Oct 28 · 5:00 PM, which has already passed"), true);
  eq("...even for a kickoff", line("2026-10-28 17:00:00", { scope: "MATCH", matchId: 116 }).includes("already passed"), true);
  eq("a coming end reads as before (the control)", line("2026-11-01 23:59:00").includes("until Sun 11:59 PM"), true);
  eq("the ticket for a past end is a date, not a weekday", endsTicket(past, NOW), "Ends Wed, Oct 28");
}


// ── THE END, IN THE OFFER'S OWN CITIES ───────────────────────────────────────────────────────────
{
  const C: City[] = [{ id: 1, name: "Austin", timeZone: "America/Chicago" }, { id: 2, name: "Houston", timeZone: "America/Chicago" }, { id: 3, name: "New York", timeZone: "America/New_York" }, { id: 4, name: "Los Angeles", timeZone: "America/Los_Angeles" }, { id: 5, name: "No zone", timeZone: null }];
  const AT = new Date("2026-10-30T21:30:00Z"); // 4:30 PM Chicago, 5:30 PM New York, 2:30 PM Los Angeles
  const filt = (cityIds: number[]) => ({ cityIds, audienceMode: "FILTERS" as const });
  eq("each zone's wall clock", [wallNowIn("America/Chicago", AT), wallNowIn("America/New_York", AT), wallNowIn("America/Los_Angeles", AT)], ["2026-10-30 16:30:00", "2026-10-30 17:30:00", "2026-10-30 14:30:00"]);
  eq("Chicago's helper is the same clock (the control)", chicagoWallNow(AT), "2026-10-30 16:30:00");
  eq("wall clock follows DST, not a fixed offset", [wallNowIn("America/Chicago", new Date("2026-07-01T17:00:00Z")), wallNowIn("America/Chicago", new Date("2026-12-01T17:00:00Z"))], ["2026-07-01 12:00:00", "2026-12-01 11:00:00"]);
  eq("a zone Intl doesn't know reads as UTC, and doesn't throw", wallNowIn("Mars/Olympus", AT), "2026-10-30 21:30:00");
  eq("one city: its zone", offerZones(filt([4]), null, C), ["America/Los_Angeles"]);
  eq("two cities in one zone: once", offerZones(filt([1, 2]), null, C), ["America/Chicago"]);
  eq("no city: every city's zone", offerZones(filt([]), null, C), ["America/Chicago", "America/New_York", "America/Los_Angeles"]);
  eq("specific players: every city's zone, whatever cityIds holds", offerZones({ cityIds: [4], audienceMode: "PLAYERS" }, null, C).length, 3);
  eq("a specific match adds its city", offerZones(filt([4]), 3, C), ["America/New_York", "America/Los_Angeles"]);
  eq("a match in all cities: just its city", offerZones(filt([]), 4, C), ["America/Los_Angeles"]);
  eq("nothing known: UTC", offerZones(filt([5]), null, C), ["UTC"]);
  const end = "2026-10-30 17:00:00"; // 5:00 PM on the wall
  const past = (cityIds: number[], match: number | null = null) => endHasPassed(end, offerWallNow(offerZones(filt(cityIds), match, C), AT));
  eq("5 PM has passed in New York at 5:30 there", past([3]), true);
  eq("...and hasn't in Chicago or Los Angeles (the controls)", [past([1]), past([4])], [false, false]);
  eq("Chicago and New York together: the earliest decides", past([1, 3]), true);
  eq("Chicago and Los Angeles together: neither yet", past([1, 4]), false);
  eq("all cities: New York decides", past([]), true);
  eq("the match's city counts", past([4], 3), true);
  eq("the Chicago clock alone would have said otherwise (why this changed)", endHasPassed(end, chicagoWallNow(AT)), false);
  eq("the summary uses that clock", summary({ ...nowF, name: "x", cityIds: [3], endsLocal: end }, { count: 1, heldBack: 0, players: 1, mostItCanCost: null }, [], C, offerWallNow(["America/New_York"], AT)).includes("already passed"), true);
}

// ── NO END DATE ──────────────────────────────────────────────────────────────────────────────────
{
  const noEnd = { ...nowF, name: "x", endsLocal: null };
  const cnt = { count: 3, heldBack: 0, players: 3, mostItCanCost: null };
  eq("the summary says until you end it, and no date", [summary(noEnd, cnt, matches, cities, NOW).includes("until you end it"), lockedSummary(noEnd, matches, cities, NOW).includes("until you end it")], [true, true]);
  eq("a dated offer doesn't (the control)", summary({ ...nowF, name: "x" }, cnt, matches, cities, NOW).includes("until you end it"), false);
  eq("no end saves and launches on any match", [formProblem(noEnd, matches), launchProblem(noEnd, NOW), endHasPassed(null, NOW)], [null, null, false]);
  eq("a specific match can't have it", formProblem({ ...noEnd, scope: "MATCH", matchId: 116 }, matches), "A specific match always ends at kickoff.");
  eq("the ticket has no end time", endsTicket(null, NOW), null);
  eq("a create sends the null, not a date", "endsLocal" in createBody(noEnd, matches, cities) && createBody(noEnd, matches, cities).endsLocal === null, true);
  const dated = draftFrom();
  eq("an edit sends just the null", patchBody(dated, { ...formOf(dated, matches, cities), endsLocal: null }, matches, cities), { endsLocal: null });
  const stored = draftFrom({ endsLocal: null });
  eq("loaded with none and untouched, nothing to send", patchBody(stored, formOf(stored, matches, cities), matches, cities), {});
  eq("after launch it's locked like any date", patchBody({ ...stored, status: "LAUNCHED" }, { ...formOf(stored, matches, cities), endsLocal: "2026-11-05 23:59:00" }, matches, cities), {});
  const running = (state: Campaign["state"]) => ({ ...stored, state, startsLocal: "2026-10-27 10:00:00" });
  eq("progress counts days with no total, and never reads NaN", [progressText(running("LIVE"), NOW), progressText(running("PAUSED"), NOW), progressText(running("ENDED"), NOW)], ["Day 3", "Paused · day 3", "Ended"]);
}

eq("no end date: End and Pause say what happens to players holding it", [endNote(null), pauseNote(null)], ["Players lose this offer immediately. It can't be launched again.", "No new players get it; players who have it can still use it until you end it. You can resume it."]);
eq("with an end date: today's rule, today's words", [endNote("2026-11-02 19:00:00"), pauseNote("2026-11-02 19:00:00")], ["Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. It can't be launched again.", "Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. You can resume it."]);

{
  const noEndForm = { ...nowF, name: "x", cityIds: [2], lastPlayed: "NEVER" as const, endsLocal: null };
  const ended = { status: "ENDED" as const, endsLocal: null, updatedAt: "2026-10-31T14:25:47.705Z" };
  eq("ended with no end date: the day it was ended", ranUntil(ended), "Ran until Sat, Oct 31");
  eq("the day is Chicago's, not UTC's", ranUntil({ ...ended, updatedAt: "2026-11-01T03:00:00.000Z" }), "Ran until Sat, Oct 31");
  eq("the summary says it instead of until you end it", lockedSummary(noEndForm, matches, cities, NOW, [], ranUntil(ended)), "Houston · Never played: 50% off one match. Ran until Sat, Oct 31.");
  eq("still running: not yet", [ranUntil({ ...ended, status: "LAUNCHED" }), ranUntil({ ...ended, status: "PAUSED" }), lockedSummary(noEndForm, matches, cities, NOW, [], null).includes("until you end it")], [null, null, true]);
  eq("ended with an end date: unchanged (the control)", ranUntil({ ...ended, endsLocal: "2026-11-01 23:59:00" }), null);
  eq("no usable date: never a wrong one", [ranUntil({ ...ended, updatedAt: undefined }), ranUntil({ ...ended, updatedAt: "nope" })], ["Ended", "Ended"]);
}

// ── A FIELD: where it can be used, not who gets it ───────────────────────────────────────────────
{
  const F = [{ id: 1, title: "Riverside Fields", cityId: 1, cover: "https://c/r.jpg" }, { id: 2, title: "Mueller Park", cityId: 1, cover: null }, { id: 3, title: "Zilker", cityId: 1, cover: "https://c/z.jpg" }];
  const one = { ...nowF, name: "x", scope: "FIELD" as const, appliesFieldIds: [1], endsLocal: "2026-11-08 23:59:00" };
  const two = { ...one, appliesFieldIds: [1, 2] };
  const three = { ...one, appliesFieldIds: [1, 2, 3] };
  const cnt = { count: 3, heldBack: 0, players: 3, mostItCanCost: null };
  eq("the line names one field", autoCopy(one, matches, cities, F).line, "ANY MATCH AT RIVERSIDE FIELDS");
  eq("...or the first and how many more", [autoCopy(two, matches, cities, F).line, autoCopy(three, matches, cities, F).line], ["AT RIVERSIDE FIELDS AND 1 MORE", "AT RIVERSIDE FIELDS AND 2 MORE"]);
  eq("the body says the deal, the field and the end", autoCopy(one, matches, cities, F).body, "50% off any match at Riverside Fields until Sun, Nov 8.");
  eq("every field is named in the body", autoCopy(two, matches, cities, F).body, "50% off any match at Riverside Fields and Mueller Park until Sun, Nov 8.");
  eq("with no end date, no until", autoCopy({ ...one, endsLocal: null }, matches, cities, F).body, "50% off any match at Riverside Fields.");
  eq("each deal reads right", [autoCopy({ ...one, dealType: "AMOUNT_OFF", dealAmount: 500 }, matches, cities, F).body, autoCopy({ ...one, dealType: "SET_PRICE", dealAmount: 500 }, matches, cities, F).body, autoCopy({ ...one, dealType: "FREE_MATCH", dealAmount: 0 }, matches, cities, F).body, autoCopy({ ...one, usesPerPlayer: 3 }, matches, cities, F).body],
    ["$5 off any match at Riverside Fields until Sun, Nov 8.", "A $5 spot in any match at Riverside Fields until Sun, Nov 8.", "A free match at Riverside Fields until Sun, Nov 8.", "50% off any 3 matches at Riverside Fields until Sun, Nov 8."]);
  eq("the photo is the first chosen field's cover", [autoCopy(one, matches, cities, F).photoUrl, autoCopy({ ...one, appliesFieldIds: [2, 3] }, matches, cities, F).photoUrl], ["https://c/r.jpg", null]);
  eq("the button finds a match, and can't be pointed at one", [buttonOf({ ...one, buttonTarget: "MATCH", buttonMatchId: 116 }, matches), autoCopy(one, matches, cities, F).buttonLabel], [{ target: "FIND_MATCH", matchId: null, locked: true }, "Find a match"]);
  eq("the body sent has no match for the button", [createBody({ ...one, buttonTarget: "MATCH", buttonMatchId: 116 }, matches, cities, F).buttonTarget, "buttonMatchId" in createBody(one, matches, cities, F)], ["FIND_MATCH", false]);
  eq("the summary names them", [summary(one, cnt, matches, cities, NOW, F).includes("get 50% off one match at Riverside Fields until"), summary(two, cnt, matches, cities, NOW, F).includes("at Riverside Fields and Mueller Park until"), lockedSummary(one, matches, cities, NOW, F).includes("one match at Riverside Fields")], [true, true, true]);
  eq("the list row names them", [scopeFieldsLine({ usesPerPlayer: 1, appliesFieldIds: [1] }, F), scopeFieldsLine({ usesPerPlayer: 2, appliesFieldIds: [1, 2] }, F)], ["1 match at Riverside Fields", "2 matches at Riverside Fields and Mueller Park"]);
  // Where it works and who gets it stay two different things on the wire: a field offer must never save as an audience filter alone.
  const sent = createBody(one, matches, cities, F);
  eq("Played at suggests each chosen field", playedAtSuggestions(two, F).map((x) => x.id), [1, 2]);
  eq("...until it's added", playedAtSuggestions({ ...two, fieldIds: [1] }, F).map((x) => x.id), [2]);
  eq("nothing to suggest on any match", playedAtSuggestions({ ...nowF, appliesFieldIds: [1] }, F, matches), []);
  const onMatch = { ...nowF, name: "x", scope: "MATCH" as const, matchId: 116, endsLocal: "2026-11-02 19:00:00" };
  eq("a specific match suggests its field", playedAtSuggestions(onMatch, F, matches), [{ id: 1, title: "Riverside Fields" }]);
  eq("...until it's added", playedAtSuggestions({ ...onMatch, fieldIds: [1] }, F, matches), []);
  eq("...and not with no match picked or no field on it", [playedAtSuggestions({ ...onMatch, matchId: null }, F, matches), playedAtSuggestions(onMatch, F, [{ ...matches[0], fieldId: null, fieldTitle: null }])], [[], []]);
  eq("a specific match's offer doesn't send Played at unless asked", createBody(onMatch, matches, cities, F).fieldIds, []);
  eq("the scope is sent as its own value", sent.appliesFieldIds, [1]);
  eq("...and not as Played at", sent.fieldIds, []);
  eq("sorted, as an id set", createBody({ ...one, appliesFieldIds: [3, 1] }, matches, cities, F).appliesFieldIds, [1, 3]);
  eq("it never goes to the count, which doesn't depend on it", "appliesFieldIds" in audienceBody(one, matches, cities), false);
  eq("any match and a specific match send nothing new", ["appliesFieldIds" in createBody({ ...nowF, name: "x" }, matches, cities, F), "appliesFieldIds" in createBody({ ...nowF, name: "x", scope: "MATCH", matchId: 116 }, matches, cities, F)], [false, false]);
  eq("no field picked stops the save", formProblem({ ...one, appliesFieldIds: [] }, matches), "Pick at least one field.");
  eq("one picked saves (the control)", formProblem(one, matches), null);
  const stored = draftFrom({ appliesFieldIds: [1], line: "ANY MATCH AT RIVERSIDE FIELDS", body: "50% off any match at Riverside Fields until Mon, Nov 2.", photoUrl: "https://c/r.jpg", buttonLabel: "Find a match", endsLocal: "2026-11-02 23:59:00" });
  const loaded = formOf(stored, matches, cities, F);
  eq("a stored field offer loads as one", [loaded.scope, loaded.appliesFieldIds], ["FIELD", [1]]);
  eq("loaded and untouched, nothing to send", patchBody(stored, loaded, matches, cities, F), {});
  eq("its suggested text isn't taken for typed", [loaded.copy.line, loaded.copy.body, loaded.copy.photoUrl], [undefined, undefined, undefined]);
  eq("an edit sends the new set", patchBody(stored, { ...loaded, appliesFieldIds: [1, 2] }, matches, cities, F).appliesFieldIds, [1, 2]);
  eq("back to any match clears it", patchBody(stored, { ...loaded, scope: "ANY", appliesFieldIds: [] }, matches, cities, F).appliesFieldIds, []);
  eq("after launch it's locked", "appliesFieldIds" in patchBody({ ...stored, status: "LAUNCHED" }, { ...loaded, appliesFieldIds: [1, 2] }, matches, cities, F), false);
  eq("a backend without it reads as any match", [formOf(draftFrom(), matches, cities, F).scope, patchBody(draftFrom(), formOf(draftFrom(), matches, cities, F), matches, cities, F)], ["ANY", {}]);
  eq("the read-back ignores the order of the set", mismatches({ appliesFieldIds: [1, 2] }, { appliesFieldIds: [2, 1] }), []);
  eq("...and catches a backend that dropped it", mismatches({ appliesFieldIds: [1] }, {}), ["appliesFieldIds"]);
  const cheap = { ...one, dealType: "SET_PRICE" as const, dealAmount: 1000, cityIds: [] };
  eq("the set-price warning looks only at those fields", [anyPriceWarn(cheap, matches), anyPriceWarn({ ...cheap, appliesFieldIds: [2] }, matches)?.includes("as low as $9")], [null, true]);
  eq("the cost ceiling too", [costCeiling(one, cnt, matches)?.basis, costCeiling({ ...one, appliesFieldIds: [2] }, cnt, matches)?.basis], ["at today's top price of $15", "at today's top price of $9"]);
}

eq("an admin account is one; a player or a backend without the type isn't", [isAdminAccount({ type: "ADMIN" }), isAdminAccount({ type: "PLAYER" }), isAdminAccount({})], [true, false, false]);

// ── THE TICKET ───────────────────────────────────────────────────────────────────────────────────
{
  const f = { ...nowF, name: "x" };
  eq("a shown ticket isn't sent on a create", "showTicket" in createBody(f, matches, cities), false);
  eq("a removed one is", createBody({ ...f, showTicket: false }, matches, cities).showTicket, false);
  const old = draftFrom();
  eq("a backend that has no such field reads as shown, with nothing to send", [formOf(old, matches, cities).showTicket, patchBody(old, formOf(old, matches, cities), matches, cities)], [true, {}]);
  eq("removing it sends just that", patchBody(old, { ...formOf(old, matches, cities), showTicket: false }, matches, cities), { showTicket: false });
  const gone = draftFrom({ showTicket: false });
  eq("stored removed stays removed, with nothing to send", [formOf(gone, matches, cities).showTicket, patchBody(gone, formOf(gone, matches, cities), matches, cities)], [false, {}]);
  eq("adding it back sends true", patchBody(gone, { ...formOf(gone, matches, cities), showTicket: true }, matches, cities), { showTicket: true });
  eq("it can change after launch, like the rest of the popup", patchBody({ ...old, status: "LAUNCHED" }, { ...formOf(old, matches, cities), showTicket: false }, matches, cities), { showTicket: false });
}

// ── A SPECIFIC MATCH'S BODY ──────────────────────────────────────────────────────────────────────
{
  const on = (id: number) => autoCopy({ ...nowF, scope: "MATCH", matchId: id }, matches, cities);
  eq("the body says when and where, as the line does", [on(116).body, on(116).line], ["Mon 7:00 PM · Riverside Fields, normally $15. The discount is already on your account.", "MON 7:00 PM · RIVERSIDE FIELDS"]);
  eq("never the stored name", [on(116).body?.includes("Riverside Thursday"), on(117).body?.includes("Mueller Friday")], [false, false]);
  const noField = autoCopy({ ...nowF, scope: "MATCH", matchId: 9 }, [{ ...matches[0], id: 9, fieldTitle: null }], cities);
  const cnt = { count: 3, heldBack: 0, players: 3, mostItCanCost: null };
  const line = (over = {}) => summary({ ...nowF, name: "x", scope: "MATCH", matchId: 116, endsLocal: "2026-11-02 19:00:00", ...over }, cnt, matches, cities, NOW);
  eq("the summary says when and where", line().includes("get 50% off Mon 7:00 PM · Riverside Fields until kickoff"), true);
  eq("...for every deal, never the name", [line({ dealType: "SET_PRICE", dealAmount: 500 }).includes("a $5 spot in Mon 7:00 PM · Riverside Fields"), line({ dealType: "FREE_MATCH", dealAmount: 0 }).includes("Mon 7:00 PM · Riverside Fields free"), line().includes("Riverside Thursday"), line({ dealType: "SET_PRICE", dealAmount: 500 }).includes("Riverside Thursday"), line({ dealType: "FREE_MATCH", dealAmount: 0 }).includes("Riverside Thursday")], [true, true, false, false, false]);
  eq("the locked summary too", lockedSummary({ ...nowF, name: "x", scope: "MATCH", matchId: 116, endsLocal: "2026-11-02 19:00:00" }, matches, cities, NOW).includes("Riverside Thursday"), false);
  const hit = (search: string) => pickerView(matches, { search, days: 14, needsPlayers: false, cityIds: [] }, NOW, cities).shown;
  eq("the picker's search finds the name and the field, not the time", [hit("thursday"), hit("riverside"), hit("7:00")], [1, 1, 0]);
  eq("staff see it by name, then field and city", [matchTitle(matches[0]), matchWhere(matches[0], cities), matchPicked(matches[0])], ["Riverside Thursday", "Riverside Fields · Austin", "Mon 7:00 PM · Riverside Thursday"]);
  eq("no field or no known city leaves just what's known", [matchWhere({ fieldTitle: null, cityId: 1 }, cities), matchWhere({ fieldTitle: "F", cityId: 99 }, cities)], ["Austin", "F"]);
  eq("a blank name falls back, never empty", [matchTitle({ id: 9, name: " ", fieldTitle: "F" }), matchTitle({ id: 9, name: "", fieldTitle: null })], ["F", "Match 9"]);
  const popup = autoCopy({ ...nowF, scope: "MATCH", matchId: 116 }, matches, cities);
  eq("what the player sees still never has the name", [popup.line, popup.body, popup.caption], ["MON 7:00 PM · RIVERSIDE FIELDS", "Mon 7:00 PM · Riverside Fields, normally $15. The discount is already on your account.", "Your spot at Riverside Fields is waiting."]);
  eq("with no field, just the time", noField.body, "Mon 7:00 PM, normally $15. The discount is already on your account.");
}


// ── OFFER PUSHES (backend docs/offer-push.md) ────────────────────────────────────────────────────
{
  const F2 = [{ id: 1, title: "Riverside Fields", cityId: 1, cover: null }];
  const any = { ...nowF, name: "x", endsLocal: "2026-11-08 23:59:00" };
  const onMatch = { ...any, scope: "MATCH" as const, matchId: 116 };
  const onField = { ...any, scope: "FIELD" as const, appliesFieldIds: [1] };
  eq("any match: the deal in the title, the end day in the body", pushSuggestion(any, null, F2), { title: "Your next match is 50% off", body: "{first_name}, it's already on your account. Ends Sun, Nov 8." });
  eq("...each deal, and more than one use", [pushSuggestion({ ...any, dealType: "FREE_MATCH", dealAmount: 0 }, null, F2).title, pushSuggestion({ ...any, dealType: "SET_PRICE", dealAmount: 500 }, null, F2).title, pushSuggestion({ ...any, dealType: "AMOUNT_OFF", dealAmount: 300 }, null, F2).title, pushSuggestion({ ...any, usesPerPlayer: 3 }, null, F2).title],
    ["Your next match is free", "Your next match is $5", "Your next match is $3 off", "Your next 3 matches are 50% off"]);
  eq("...no end date: no Ends", pushSuggestion({ ...any, endsLocal: null }, null, F2).body, "{first_name}, it's already on your account.");
  eq("a specific match: deal and its name, then its day and time", pushSuggestion(onMatch, matches[0], F2), { title: "50% off Riverside Thursday", body: "{first_name}, Mon Nov 2 7:00 PM. Already applied." });
  eq("...free says the match is free", pushSuggestion({ ...onMatch, dealType: "FREE_MATCH", dealAmount: 0 }, matches[0], F2).title, "Riverside Thursday is free");
  eq("a field: deal at the field", pushSuggestion(onField, null, F2), { title: "50% off at Riverside Fields", body: "{first_name}, any match there. Already applied." });
  eq("...free says any match there is free", pushSuggestion({ ...onField, dealType: "FREE_MATCH", dealAmount: 0 }, null, F2).title, "Any match at Riverside Fields is free");
  eq("a long match name is cut to the title's limit", pushSuggestion(onMatch, { ...matches[0], name: "x".repeat(80) }, F2).title.length, 64);
  eq("no first name: dropped with its comma, as the backend's fillFirstName does", [fillPush("{first_name}, it's already on your account.", null, null), fillPush("See you, {first_name}!", null, null), fillPush("No name here.", null, null), fillPush("{first_name}, it's on.", null)],
    ["It's already on your account.", "See you!", "No name here.", "Luis, it's on."]);
  eq("no first name: a capital only when the text opened with it, as backend 7fadcae does", [fillPush("  {first_name} your spot is waiting", null, null), fillPush("see you soon, {first_name}", null, null), fillPush("{first_name}, 50% off tonight", null, null), fillPush("{first_name}, {match} has spots", matches[0], null)],
    ["Your spot is waiting", "see you soon", "50% off tonight", "Riverside Thursday, Mon Nov 2 7:00 PM has spots"]);
  eq("set price on a specific match: a spot at it", pushSuggestion({ ...onMatch, dealType: "SET_PRICE", dealAmount: 500 }, matches[0], F2).title, "$5 spot at Riverside Thursday");
  eq("a field with no name to hand: the deal alone, no dangling \"at\" or \"there\"", [pushSuggestion({ ...onField, appliesFieldIds: [999] }, null, F2), pushSuggestion({ ...onField, appliesFieldIds: [999], dealType: "SET_PRICE", dealAmount: 500 }, null, F2).title, pushSuggestion({ ...onField, appliesFieldIds: [999], dealType: "FREE_MATCH", dealAmount: 0 }, null, F2).title],
    [{ title: "50% off", body: "{first_name}, it's already on your account." }, "$5 spots", "Free match"]);
  eq("the cut-off warning counts the filled text: {match} alone is long, a short template filled stays short", [mayCutOff("{match}, 50% off now", PUSH_TITLE_SOFT, PUSH_TITLE_MAX, { ...matches[0], name: "Riverside Fields Thursday Night Lights" }), mayCutOff("{match}", PUSH_TITLE_SOFT, PUSH_TITLE_MAX, matches[0]), mayCutOff("x".repeat(51), PUSH_TITLE_SOFT, PUSH_TITLE_MAX, null), mayCutOff("x".repeat(65), PUSH_TITLE_SOFT, PUSH_TITLE_MAX, null)],
    [true, false, true, false]);
  eq("the confirm says who it sends to", [sendsToLine(636), sendsToLine(1), sendsToLine(12400)], ["Sends to 636 players.", "Sends to 1 player.", "Sends to 12,400 players."]);
  eq("past 50 or 110 characters: a warning, still under the limits", [PUSH_TITLE_SOFT, PUSH_BODY_SOFT, PUSH_TITLE_SOFT < PUSH_TITLE_MAX, PUSH_BODY_SOFT < PUSH_BODY_MAX, CUT_OFF_NOTE], [50, 110, true, true, "May be cut off on the lock screen."]);
  const sugg = { title: "50% OFF", body: "{first_name}, 50% off your next match. It's already on your account." };
  const off = pushFormOf(null, sugg, "2026-11-03 10:00");
  eq("no push stored: off, nothing to send", [off.enabled, pushDirty(null, off, sugg), pushDirty(undefined, off, sugg)], [false, false, false]);
  const on = { ...off, enabled: true };
  eq("ticking it is a change, and sends the suggestion for now", [pushDirty(null, on, sugg), pushBodyOf(on, sugg)], [true, { enabled: true, title: "50% OFF", body: sugg.body, sendLocal: null }]);
  eq("at a time sends the local time", pushBodyOf({ ...on, at: true }, sugg).sendLocal, "2026-11-03 10:00");
  eq("off sends only enabled false", pushBodyOf(off, sugg), { enabled: false });
  const stored: CampaignPush = { enabled: true, title: "50% OFF", body: sugg.body, sendLocal: null, status: "WAITING", queuedAt: null };
  const loaded = pushFormOf(stored, sugg, "2026-11-03 10:00");
  eq("stored like the suggestion: following it, nothing to send", [loaded.title, loaded.body, pushDirty(stored, loaded, sugg)], [undefined, undefined, false]);
  eq("stored text that differs was typed", pushFormOf({ ...stored, title: "Hey" }, sugg, "x").title, "Hey");
  eq("...and the deal moving doesn't make it a change", pushDirty({ ...stored, title: "Hey" }, pushFormOf({ ...stored, title: "Hey" }, sugg, "x"), { ...sugg, title: "40% OFF" }), false);
  eq("following text moves with the deal, and that is a change to save", pushDirty(stored, loaded, { ...sugg, title: "40% OFF" }), true);
  eq("typing the suggestion goes back to following it", pushAfterType({ ...loaded, title: "Hey" }, "title", "50% OFF", sugg).title, undefined);
  eq("turning it off is a change", pushDirty(stored, { ...loaded, enabled: false }, sugg), true);
  eq("problems: empty, too long, a bad time", [pushProblem({ ...on, title: " " }, sugg, "ANY"), pushProblem({ ...on, body: "" }, sugg, "ANY"), pushProblem({ ...on, title: "x".repeat(65) }, sugg, "ANY"), pushProblem({ ...on, body: "x".repeat(241) }, sugg, "ANY"), pushProblem({ ...on, at: true, sendLocal: "2026-11-03 10:00:00" }, sugg, "ANY")],
    ["The push needs a title.", "The push needs a body.", "The push title is over 64 characters.", "The push body is over 240 characters.", "Set when the push goes out."]);
  eq("{match} only on a specific match", [pushProblem({ ...on, body: "{match}" }, sugg, "ANY"), pushProblem({ ...on, body: "{match}" }, sugg, "FIELD"), pushProblem({ ...on, body: "{match}" }, sugg, "MATCH")], ["{match} only works on an offer for a specific match.", "{match} only works on an offer for a specific match.", null]);
  eq("off has no problems, whatever the text", pushProblem({ ...off, title: "" }, sugg, "ANY"), null);
  eq("a good push has none (the control)", pushProblem(on, sugg, "ANY"), null);
  eq("the preview fills both placeholders as the backend does", [matchForPush(matches[0]), fillPush("{first_name}, 50% off {match}.", matches[0])], ["Riverside Thursday, Mon Nov 2 7:00 PM", "Luis, 50% off Riverside Thursday, Mon Nov 2 7:00 PM."]);
  eq("a send time before the start or after the end is called out", [sendTimeNote({ ...on, at: true, sendLocal: "2026-10-28 10:00" }, "2026-10-29 10:00:00", "2026-11-08 23:59:00") !== null, sendTimeNote({ ...on, at: true, sendLocal: "2026-11-09 10:00" }, "2026-10-29 10:00:00", "2026-11-08 23:59:00") !== null, sendTimeNote({ ...on, at: true, sendLocal: "2026-11-01 10:00" }, "2026-10-29 10:00:00", "2026-11-08 23:59:00"), sendTimeNote({ ...on, at: true, sendLocal: "2026-12-01 10:00" }, "2026-10-29 10:00:00", null)], [true, true, null, null]);
  eq("not sent says the backend's reason", (["PUSHES_OFF", "NO_ONE_REACHED", "NO_AUDIENCE", "PAUSED_OR_ENDED"] as const).map((r) => pushStatusText({ status: "NOT_SENT", notSentReason: r })),
    ["Not sent: pushes are off", "Not sent: nobody could be reached", "Not sent: no players match", "Not sent: offer was paused or ended"]);
  eq("...and with no reason (an older backend), only that it wasn't sent", [pushStatusText({ status: "NOT_SENT" }), pushStatusText({ status: "NOT_SENT", notSentReason: null })], ["Not sent", "Not sent"]);
  eq("sent says how many, when the backend does", [pushStatusText({ status: "SENT", sent: 612 }), pushStatusText({ status: "SENT", sent: 1 }), pushStatusText({ status: "SENT" }), pushStatusText({ status: "WAITING", sent: 0 })], ["Sent to 612 players", "Sent to 1 player", "Sent", "Goes when the offer launches"]);
  eq("queued, sent or not sent locks it; ended locks it; waiting doesn't", [pushLocked({ ...stored, status: "SCHEDULED" }, "LAUNCHED"), pushLocked({ ...stored, status: "SENT" }, "LAUNCHED"), pushLocked({ ...stored, status: "NOT_SENT" }, "PAUSED"), pushLocked(stored, "ENDED"), pushLocked(stored, "DRAFT"), pushLocked(null, "LAUNCHED")], [true, true, true, true, false, false]);
  eq("the reach adds up, or says it doesn't", [reachAddsUp({ audience: 1240, heldBack: 118, noConsent: 402, noDevice: 61, capped: 23, reachable: 636 }), reachAddsUp({ audience: 10, heldBack: 1, noConsent: 0, noDevice: 0, capped: 0, reachable: 10 })], [true, false]);
  eq("skipped is every reason", skippedTotal({ heldBack: 118, noConsent: 402, noDevice: 61, capped: 23, notAllowed: 5 }), 609);
  const r0 = { audience: 1240, heldBack: 118, noConsent: 402, noDevice: 61, capped: 23, reachable: 636 };
  eq("old app: a row and part of the sum when the backend sends it", [reachRows({ ...r0, oldApp: 40, reachable: 596 }).find(([k]) => k === "Old app"), reachAddsUp({ ...r0, oldApp: 40, reachable: 596 }), skippedRows({ heldBack: 1, noConsent: 0, noDevice: 0, oldApp: 7, capped: 0, notAllowed: 0 }).find(([k]) => k === "Old app"), skippedTotal({ heldBack: 1, noConsent: 0, noDevice: 0, oldApp: 7, capped: 0, notAllowed: 0 })], [["Old app", -40], true, ["Old app", 7], 8]);
  eq("...and no row when it doesn't (an older backend)", [reachRows(r0).some(([k]) => k === "Old app"), skippedRows({ heldBack: 1, noConsent: 0, noDevice: 0, capped: 0, notAllowed: 0 }).some(([k]) => k === "Old app"), reachRows(r0).length], [false, false, 5]);
  // OFFER_PUSH_MODE in the reach (backend 44a0715): the backend's own int-spec numbers for off, allowlist and live.
  {
    const off: Reach = { mode: "off", reason: "Pushes are off", audience: 4, notAllowed: 4, heldBack: 0, noConsent: 0, noDevice: 0, oldApp: 0, capped: 0, reachable: 0 };
    const allow: Reach = { mode: "allowlist", reason: null, audience: 4, notAllowed: 3, heldBack: 0, noConsent: 0, noDevice: 0, oldApp: 0, capped: 0, reachable: 1 };
    const live: Reach = { mode: "live", reason: null, audience: 4, notAllowed: 0, heldBack: 0, noConsent: 1, noDevice: 0, oldApp: 0, capped: 1, reachable: 2 };
    const view = (r: Reach) => ({ head: reachHeadline(r), note: reachModeNote(r), addsUp: reachAddsUp(r), warns: reachWarns(r), sends: sendsToText(r), notAllowedRow: reachRows(r)[1] });
    eq("off: Pushes are off · sends to 0, everyone not allowed, adds up, no warning", view(off),
      { head: ["Pushes are off · sends to 0", ""], note: null, addsUp: true, warns: false, sends: "Pushes are off · sends to 0.", notAllowedRow: ["Not allowed yet", -4] });
    eq("off never says the numbers don't add up, even when they don't", [reachAddsUp({ ...off, notAllowed: 3 }), reachWarns({ ...off, notAllowed: 3 })], [false, false]);
    eq("allowlist: the not-allowed row, the test-mode note, and it adds up with notAllowed in", view(allow),
      { head: ["≈ 1", "reachable by push"], note: "Test mode: only allowlisted staff get pushes", addsUp: true, warns: false, sends: "Sends to 1 player.", notAllowedRow: ["Not allowed yet", -3] });
    eq("allowlist with nobody listed: 0 reachable, still not the off line (the mode isn't off)", reachHeadline({ ...allow, notAllowed: 4, reachable: 1 - 1 }), ["≈ 0", "reachable by push"]);
    eq("live: no note, adds up, and a sum that's off still warns (the control)", [view(live), reachWarns({ ...live, reachable: 3 })],
      [{ head: ["≈ 2", "reachable by push"], note: null, addsUp: true, warns: false, sends: "Sends to 2 players.", notAllowedRow: ["Not allowed yet", 0] }, true]);
    eq("without notAllowed counted, allowlist would not add up (notAllowed is part of the sum)", reachAddsUp({ ...allow, notAllowed: undefined }), false);
    eq("a zero row is 0, never -0 (printed as \"-0\")", reachRows(live).filter(([, v]) => v === 0).every(([, v]) => Object.is(v, 0)) && reachRows(live).some(([, v]) => v === 0), true);
    eq("an older backend (no mode, no notAllowed): no row, no note, the old headline", [reachRows(r0).some(([k]) => k === "Not allowed yet"), reachModeNote(r0), reachHeadline(r0)], [false, null, ["≈ 636", "reachable by push"]]);
  }
  eq("staging shows the controls to anyone with Offers; production to nobody until listed", [pushesVisible("staging", "a@b.c", {}), pushesVisible("local", null, {}), pushesVisible("production", "rmancuso@playmatchday.com", {}), pushesVisible("production", "RMancuso@PlayMatchday.com", { OFFERS_PUSH_ACCOUNTS: " rmancuso@playmatchday.com " }), pushesVisible("production", "x@y.z", { OFFERS_PUSH_ACCOUNTS: "rmancuso@playmatchday.com" })], [true, true, false, true, false]);
  eq("the limit's line says what it counts", [capLine(2).includes("at most 2 marketing pushes in any 7 days"), capLine(2).includes("never count"), capLine(0).startsWith("No marketing pushes")], [true, true, true]);
  eq("at a time starts at the next whole hour", [defaultSendLocal("2026-11-02 08:37:57"), defaultSendLocal("2026-11-02 23:10:00")], ["2026-11-02 09:00", "2026-11-03 00:00"]);
  eq("the title as sent follows the form", pushText({ ...on, body: "typed" }, sugg), { title: "50% OFF", body: "typed" });
}

// ── THE COUNT'S STATE ────────────────────────────────────────────────────────────────────────────
eq("on188: said under the count, 0 included (before 1.88 ships)", [on188Line({ on188: 1240 }), on188Line({ on188: 0 })], ["1,240 of these have the latest app and can see it.", "0 of these have the latest app and can see it."]);
eq("...and nothing from an older backend that doesn't send it", [on188Line({}), on188Line({ on188: undefined })], [null, null]);
eq("the debounce is 800 ms", COUNT_DEBOUNCE_MS, 800);
eq("no answer yet: loading", countState("a", null, false), "loading");
eq("the form moved past the answer: loading, even with an answer in hand", countState("b", "a", false), "loading");
eq("the form moved past a failure: loading", countState("b", "a", true), "loading");
eq("answered for this form: ready (the control)", countState("a", "a", false), "ready");
eq("failed for this form: error", countState("a", "a", true), "error");
eq("loading and error stop a launch, ready doesn't", [COUNT_BLOCK.loading !== null, COUNT_BLOCK.error !== null, COUNT_BLOCK.ready], [true, true, null]);

eq("a count is wanted for a new offer and a draft", [countWanted(null), countWanted("DRAFT")], [true, true]);
eq("no count for a launched, paused or ended offer", [countWanted("LAUNCHED"), countWanted("PAUSED"), countWanted("ENDED")], [false, false, false]);
eq("a locked offer's summary says who by its filters", lockedSummary({ ...nowF, name: "x", cityIds: [2], lastPlayed: "NEVER", endsLocal: "2026-11-01 23:59:00" }, matches, cities, NOW), "Houston · Never played: 50% off one match until Sun 11:59 PM.");
eq("the read pace is the repo's 2 seconds", OFFERS_READ_PACE_MS, 2000);
eq("a link with no headers says so instead of throwing", [settableHeaders(undefined), settableHeaders(null)], [null, null]);
eq("empty headers are fine (the control)", settableHeaders({}), []);
eq("the server refuses a link with no headers, and says why", photoLinkProblem({ method: "PUT", fileKey: "k", uploadURL: "http://localhost:3070/a" }, "localhost:3070"), "The upload link came without its headers; nothing was uploaded.");

{
  const old = [draftFrom({ id: 2, name: "b" }), draftFrom({ id: 1, name: "a" })];
  const ids = (l: Campaign[]) => l.map((c) => [c.id, c.name]);
  eq("after an edit, that campaign changes and keeps its place", ids(campaignsAfter(old, { kind: "saved", campaign: draftFrom({ id: 1, name: "z" }) })), [[2, "b"], [1, "z"]]);
  eq("the others are the same objects, untouched", campaignsAfter(old, { kind: "saved", campaign: draftFrom({ id: 1, name: "z" }) })[0] === old[0], true);
  eq("a new one goes first", ids(campaignsAfter(old, { kind: "saved", campaign: draftFrom({ id: 3, name: "c" }) })), [[3, "c"], [2, "b"], [1, "a"]]);
  eq("a delete takes it out", ids(campaignsAfter(old, { kind: "gone", id: 2 })), [[1, "a"]]);
  const withResults = { ...old[0], results };
  const { results: _dropped, ...noResults } = draftFrom({ id: 2, status: "LAUNCHED" });
  const fresh = campaignsAfter(old, { kind: "saved", campaign: { ...noResults, id: 8, state: "LIVE" } as Campaign })[0];
  eq("a new one launched at once has empty results, so its row draws", resultsLines(fresh), ["0 saw · 0 used", "$0 off · 0 came back"]);
  eq("what the read-back lacks stays", campaignsAfter([withResults], { kind: "saved", campaign: noResults as Campaign })[0].results, results);
}

// ── WHAT GOES IN THE LOG ─────────────────────────────────────────────────────────────────────────
eq("player ids become a count", offersLogBody({ name: "x", playerIds: [7, 8, 9] }), { name: "x", playerCount: 3 });
eq("test ids become a count", offersLogBody({ userIds: [7] }), { userCount: 1 });
eq("a body without ids is untouched (the control)", offersLogBody({ name: "x", cityIds: [1] }), { name: "x", cityIds: [1] });

// What the real gate answers for a row, the way authenticateMatchOpsRead uses it.
const asRow = (row: Record<string, unknown>, email = "someone@playmatchday.com") => async () => {
  const g = matchOpsReadGate(row, email);
  return g.ok
    ? { ok: true as const, supabase: {} as never, appUserId: "u1", email, isAdmin: row.is_admin === true, canEditMatches: false, canManagePlayers: false, canManagePromos: false, canEditMemberships: false, confinedCity: null, confined: false }
    : g;
};
const status = async (r: unknown) => (r instanceof Response ? r.status : "through");
const offersGetText = () => readFirstMatchPage().then(() => "read", errorText);
// Every route file under /api/offers, found on disk, so a new one can't dodge this.
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? routeFiles(p) : n === "route.ts" ? [p] : []; });
}
(async () => {
  // LOOKUP IN BATCHES: 5,829 ids are 3 requests of at most LOOKUP_BATCH, answers merged in order.
  {
    const ids = Array.from({ length: 5829 }, (_, i) => 1000 + i);
    const missing = new Set([1003, 3500, 6828]);
    const sizes: number[] = [], progress: number[] = [];
    const r = await lookupInBatches(ids, async (batch) => {
      sizes.push(batch.length);
      return { ok: true, lookup: { players: batch.filter((id) => !missing.has(id)).map((id) => ({ id, name: null, city: null, matchesPlayed: 0 })), notFound: batch.filter((id) => missing.has(id)) } };
    }, (done) => progress.push(done));
    eq("batches of 2,000: sizes and progress", [LOOKUP_BATCH, sizes, progress], [2000, [2000, 2000, 1829], [2000, 4000, 5829]]);
    eq("merged: every id once, in the order asked, not-found across batches",
      r && r.ok ? [r.lookup.players.length, r.lookup.players[0].id, r.lookup.players.at(-1)!.id, r.lookup.notFound] : r,
      [5826, 1000, 6827, [1003, 3500, 6828]]);
    // A failed batch stops the rest and returns its error, never a partial "found".
    let calls = 0;
    const failed = await lookupInBatches(ids, async () => (++calls === 2 ? { ok: false, error: "backend 502" } : { ok: true, lookup: { players: [], notFound: [] } }));
    eq("a failed batch stops there with its error", [calls, failed], [2, { ok: false, error: "backend 502" }]);
    // Cancelled (the box changed) after the first batch: no answer, no more requests.
    let c2 = 0, stop = false;
    const cancelled = await lookupInBatches(ids, async () => { c2++; stop = true; return { ok: true, lookup: { players: [], notFound: [] } }; }, undefined, () => stop);
    eq("cancelled: null and no further batches", [c2, cancelled], [1, null]);
  }

  const req = (method = "GET") => new Request("http://localhost/api/offers", { method });
  const open = () => ({ ok: true as const, config: { env: "local" as const, baseUrl: "http://localhost:3070", uploadHost: "localhost:3070" } });
  const broken = () => ({ ok: false as const, problem: "OFFERS_ENV must be local, staging or production" });
  _setOffersGateDepsForTest({ config: broken, authenticate: asRow({ is_admin: true }) });
  eq("config unset or wrong: 503 for someone with access", await status(await offersGate(req())), 503);
  _setOffersGateDepsForTest({ config: broken });
  eq("...the real check with no session: 401, never the 503", await status(await offersGate(req())), 401);
  _setOffersGateDepsForTest({ config: broken, authenticate: asRow({ can_access_growth: true }) });
  eq("...without access: 404, never the 503", await status(await offersGate(req())), 404);
  // WHO GETS IN: the Match Ops section's own decision, row by row.
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["Match Ops, no Growth, not an admin: in", { can_access_matchops: true, can_access_growth: false }, "through"],
    ["an admin: in", { is_admin: true }, "through"],
    ["Growth but not Match Ops: 404", { can_access_growth: true, can_access_matchops: false }, 404],
    ["no flags at all: 404", {}, 404],
    ["Chats only: 404", { can_access_chats: true }, 404],
    ["a city manager holding the flag: 404", { can_access_matchops: true, is_city_manager: true, city_identifier: "ATX" }, 404],
    ["a service account holding the flag: 404", { can_access_matchops: true, is_service_account: true }, 404],
  ];
  for (const [name, row, want] of cases) {
    _setOffersGateDepsForTest({ config: open, authenticate: asRow(row) });
    eq(name, await status(await offersGate(req("POST"))), want);
  }
  _setOffersGateDepsForTest({ config: open, authenticate: asRow({ can_access_matchops: true }, "clubhouse-e2e@playmatchday.com") });
  eq("the E2E account by email: 404", await status(await offersGate(req())), 404);
  _setOffersGateDepsForTest({ config: open, authenticate: async () => ({ ok: true as const, supabase: {} as never, appUserId: "u1", email: "not-an-email", isAdmin: false, canEditMatches: false, canManagePlayers: false, canManagePromos: false, canEditMemberships: false, confinedCity: null, confined: false }) });
  eq("in, but with no usable email: a write is refused 401", await status(await offersGate(req("POST"))), 401);
  // offersGate's own confined check: the same caller let through by auth, confined or not (the control).
  {
    const passed = (confined: boolean) => async () => ({ ok: true as const, supabase: {} as never, appUserId: "u1", email: "jf@playmatchday.pl", isAdmin: false, canEditMatches: false, canManagePlayers: false, canManagePromos: false, canEditMemberships: false, confinedCity: confined ? "WAW" : null, confined });
    _setOffersGateDepsForTest({ config: open, authenticate: passed(false) });
    const notConfined = await status(await offersGate(req("POST")));
    _setOffersGateDepsForTest({ config: open, authenticate: passed(true) });
    eq("let through by auth: unconfined is in, confined is 404 from offersGate itself", [notConfined, await status(await offersGate(req("POST"))), await status(await offersGate(req()))], ["through", 404, 404]);
  }
  // The real check, unstubbed, as far as it goes offline.
  _setOffersGateDepsForTest({ config: open });
  eq("the real check with no session: 401, not a 404", await status(await offersGate(req())), 401);
  // EVERY ROUTE, EVERY HANDLER, the real code. The body says nothing is reached: fetch counts.
  {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const files = routeFiles(resolve(process.cwd(), "src/app/api/offers"));
    const ctx = { params: Promise.resolve({ id: "1", action: "launch" }) };
    let handlers = 0;
    const answers: Record<string, unknown> = {};
    const through: Record<string, unknown> = {};
    // CONFINED ACCOUNTS (review 2026-11-02): the Warsaw shape, Match Ops ticked and a city set. realConfined is
    // authenticateMatchOpsRead's own two checks on the route's real path; leakedConfined is the same account let through,
    // as if /api/offers were added to the confined allowlist, so only offersGate's own check stands.
    const confinedRow = { can_access_matchops: true, city_identifier: "WAW" };
    const realConfined = async (r: Request) => {
      const g = matchOpsReadGate(confinedRow, "jf@playmatchday.pl");
      if (!g.ok) return g;
      const route = assertConfinedRoute(confinedRow, r.url);
      return route.ok ? { ok: true as const, supabase: {} as never, appUserId: "u1", email: "jf@playmatchday.pl", isAdmin: false, canEditMatches: false, canManagePlayers: false, canManagePromos: false, canEditMemberships: false, confinedCity: "WAW", confined: true } : route;
    };
    const leakedConfined = async () => ({ ok: true as const, supabase: {} as never, appUserId: "u1", email: "jf@playmatchday.pl", isAdmin: false, canEditMatches: false, canManagePlayers: false, canManagePromos: false, canEditMemberships: false, confinedCity: "WAW", confined: true });
    const confinedAnswers: Record<string, unknown> = {};
    const confinedWant: Record<string, unknown> = {};
    for (const f of files) {
      const mod = (await import(f)) as Record<string, unknown>;
      const path = `/api/offers${f.split("/api/offers")[1].replace(/\/route\.ts$/, "").replace("[id]", "1").replace("[action]", "launch")}`;
      for (const m of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
        const h = mod[m] as undefined | ((r: Request, c: typeof ctx) => Promise<Response>);
        if (!h) continue;
        handlers++;
        const name = `${m} ${f.split("/api/offers")[1]}`;
        const mk = (url: string) => new Request(url, { method: m, ...(m === "GET" ? {} : { body: "{}" }) });
        _setOffersGateDepsForTest({ config: open, authenticate: asRow({ can_access_growth: true }) });
        const r = await h(mk("http://localhost/api/offers/1"), ctx);
        answers[name] = r.status;
        through[name] = 404;
        // A handler that gets past the gate may throw further in (no Supabase offline): recorded, not a crash.
        const tryStatus = (url: string) => h(mk(url), ctx).then((x) => x.status, () => "threw past the gate");
        _setOffersGateDepsForTest({ config: open, authenticate: realConfined });
        const rc = await tryStatus(`http://localhost${path}`);
        _setOffersGateDepsForTest({ config: open, authenticate: leakedConfined });
        const lc = await tryStatus(`http://localhost${path}`);
        confinedAnswers[name] = [rc, lc];
        confinedWant[name] = [404, 404];
      }
    }
    eq("the positive control: the walk found the routes", handlers >= 13, true);
    eq("without Match Ops, every handler of every route answers 404", answers, through);
    eq("a confined account, on every handler of every route: 404 through the real auth, and 404 from offersGate alone when the allowlist lets it through", confinedAnswers, confinedWant);
    eq("...and none of them reached the backend", fetched, 0);
    // The action is looked up with Object.hasOwn: what every object inherits is not an action.
    {
      const action = await import(resolve(process.cwd(), "src/app/api/offers/[id]/[action]/route.ts")) as { POST: (r: Request, c: unknown) => Promise<Response> };
      _setOffersGateDepsForTest({ config: open, authenticate: asRow({ is_admin: true }) });
      const inherited: Record<string, number> = {};
      for (const a of ["constructor", "toString", "__proto__", "hasOwnProperty", "launchx"]) inherited[a] = (await action.POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "1", action: a }) })).status;
      eq("an inherited name is not an action: 404, nothing sent", [inherited, fetched], [{ constructor: 404, toString: 404, __proto__: 404, hasOwnProperty: 404, launchx: 404 }, 0]);
    }
    globalThis.fetch = realFetch;
  }
  _setOffersGateDepsForTest(null);

  // THE PACER: fake clock, no network.
  {
    let t = 0; const slept: number[] = [];
    const pacer = makePacer({ paceMs: 1000, stopMs: 30_000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, stopsOn: (e) => (e as Error).message !== "400" });
    const seen: string[] = [];
    let running = 0, most = 0;
    const read = (name: string, ms = 10, fail?: string) => pacer(async () => { running++; most = Math.max(most, running); seen.push(`${name}@${t}`); t += ms; running--; if (fail) throw new Error(fail); return name; });
    eq("three at once come back in order", await Promise.all([read("a"), read("b"), read("c")]), ["a", "b", "c"]);
    eq("one at a time", most, 1);
    eq("each starts a full pace after the last ended", seen, ["a@0", "b@1010", "c@2020"]);
    eq("a 4xx is an answer: it fails, and doesn't stop the next", [await read("d", 10, "400").catch((e) => e.message), await read("e")], ["400", "e"]);
    const before = seen.length;
    eq("a 5xx fails", await read("f", 10, "502").catch((e) => e.message), "502");
    const firstAfter = seen.length;
    eq("the next read stops with no request", await read("g").catch((e) => e.name), READS_STOPPED);
    eq("...positive control: f did run, g did not", [firstAfter - before, seen.length - firstAfter], [1, 0]);
    t += 30_001;
    eq("after the stop it reads again, once", await read("h"), "h");
  }

  // THE LOG, on the real offersWrite and sendPreview: fetch is stubbed, so nothing leaves this process.
  {
    const realFetch = globalThis.fetch;
    const JWT = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64")}.y`;
    const sent: { url: string; body: string | null }[] = [];
    const sentStaff: (string | null)[] = [];
    const stored: { players: number[] | null } = { players: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/auth/signin")) return new Response(JSON.stringify({ accessToken: JWT }), { status: 200 });
      if (init?.method && init.method !== "GET") { sent.push({ url, body: typeof init.body === "string" ? init.body : null }); sentStaff.push(new Headers(init.headers).get("X-Acting-Staff-Email")); }
      if (url.endsWith("/send-preview")) return new Response(JSON.stringify({ sent: [7, 8], notFound: [] }), { status: 200 });
      if (init?.method === "POST") { const b = JSON.parse(String(init.body)); stored.players = b.playerIds; return new Response(JSON.stringify({ id: 9, status: "DRAFT", name: b.name, playerIds: b.playerIds }), { status: 201 }); }
      return new Response(JSON.stringify({ id: 9, status: "DRAFT", name: "x", playerIds: stored.players ?? [] }), { status: 200 });
    }) as typeof fetch;
    Object.assign(process.env, { MATCHDAY_STAGE_API_BASE_URL: "https://matchday-stage.herokuapp.com", MATCHDAY_STAGE_API_EMAIL: "s@example.com", MATCHDAY_STAGE_API_PASSWORD: "x" });
    const rows: { env: string; body: Record<string, unknown>; changes: unknown; actorName: string; actorEmail: string; outcome: string }[] = [];
    const logStore = () => ({ insert: async (r: unknown) => { rows.push(r as (typeof rows)[number]); }, resolve: async () => undefined, recent: async () => [] }) as never;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    _setOffersGateDepsForTest({ sleep, logStore, config: () => ({ ok: true, config: { env: "staging", baseUrl: "https://matchday-stage.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } }) });
    const auth = { email: "someone@playmatchday.com", supabase: {} as never, actor: { canEditMatches: false, canUseOffers: true, email: "someone@playmatchday.com", userId: "u1" } } as OffersAuth;
    await apiWrite("staging", "POST", "/admin/offers/campaigns", {}, { canEditMatches: true, isAdmin: true, email: "x@y.z" }, "offers").then(() => eq("no Offers authority: refused", "sent", "refused"), (e) => eq("no Offers authority, whatever else it holds: refused before any request", [e instanceof NotAuthorizedError, sent.length], [true, 0]));
    const w = await offersWrite({ auth, source: "offers:create", method: "POST", path: "/admin/offers/campaigns", body: { name: "x", playerIds: [7, 8, 9] }, id: null, expect: { name: "x", playerIds: [7, 8, 9] } });
    eq("the write landed (the control: this is a real run of the write path)", w.verdict, "LANDED");
    eq("the request carried the ids, on the configured base", [sent[0]?.url, JSON.parse(sent[0]?.body ?? "{}").playerIds], ["https://matchday-stage.herokuapp.com/admin/offers/campaigns", [7, 8, 9]]);
    eq("the log says who did it", [rows[0]?.actorName, rows[0]?.actorEmail], ["someone@playmatchday.com", "someone@playmatchday.com"]);
    eq("the backend is told who did it", sentStaff[0], "someone@playmatchday.com");
    eq("one row was logged, under the configured env", [rows.length, rows[0]?.env], [1, "staging"]);
    eq("the row has the count", rows[0]?.body, { name: "x", playerCount: 3 });
    eq("no ids anywhere in the row, changes included", /\b[789],[789]\b/.test(JSON.stringify(rows[0])) || JSON.stringify(rows[0]).includes("playerIds"), false);
    await sendPreview(auth, 9, [7, 8]);
    eq("a test's request carries the ids", JSON.parse(sent[1]?.body ?? "{}").userIds, [7, 8]);
    eq("a test's row has the count, not the ids", [rows[1]?.body, JSON.stringify(rows[1]).includes("userIds")], [{ userCount: 2 }, false]);

    // THE REQUESTS OF EACH ROUTE, real handlers, counted. Each read is paced, and nothing is read twice.
    {
      const seen: string[] = [];
      let running = 0, most = 0;
      const campaign = (over: Record<string, unknown> = {}) => ({ id: 9, status: "LAUNCHED", name: "x", matchIds: [], cityIds: [2], audienceMode: "FILTERS", endsLocal: "2099-01-01 00:00:00", ...over });
      let current = campaign();
      let backendRefuses = false, answerEmpty = false;
      let answerStatus: string | null = null;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.pathname === "/auth/signin") return new Response(JSON.stringify({ accessToken: JWT }), { status: 200 });
        running++; most = Math.max(most, running);
        const m = init?.method ?? "GET";
        seen.push(`${m} ${url.pathname}`);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        if (m !== "GET") {
          const to = url.pathname.split("/").at(-1);
          if (backendRefuses) return new Response(JSON.stringify({ errorCode: "INVALID_OFFER_CAMPAIGN", message: "Invalid offer campaign: its end has already passed" }), { status: 400 });
          if (to === "pause") current = { ...current, status: "PAUSED" };
          if (to === "launch") current = { ...current, status: answerStatus ?? "LAUNCHED" };
          if (m === "PATCH") current = { ...current, name: "y" };
          return new Response(answerEmpty ? "{}" : JSON.stringify(current), { status: 200 });
        }
        if (url.pathname.endsWith("/admin/cities")) return new Response(JSON.stringify([{ id: 2, name: "Houston", timeZone: { name: "America/Chicago" } }]), { status: 200 });
        if (url.pathname.endsWith("/admin/offers/page")) return new Response(JSON.stringify({ campaigns: [campaign()], cities: [{ id: 2, name: "Houston", state: "TX", timeZone: "America/Chicago" }], fields: [{ id: 1, title: "F", address: "x", cityId: 2, cover: null }] }), { status: 200 });
        if (url.pathname.endsWith("/admin/offers/matches")) return new Response(JSON.stringify({ page: 1, limit: 100, totalItems: 0, data: [] }), { status: 200 });
        if (url.pathname.startsWith("/admin/matches/")) return new Response(JSON.stringify({ id: 116, name: "M", startDate: "2099-01-01T00:00:00.000Z", startDateUtc: "2099-01-01T00:00:00.000Z", isCancelled: false, fieldId: 1, registrationPrice: 900, maxPlayerCount: 16, minPlayerCount: 0, field: { title: "F", cityId: 2 } }), { status: 200 });
        return new Response(JSON.stringify(current), { status: 200 });
      }) as typeof fetch;
      _setOffersGateDepsForTest({ sleep, logStore, authenticate: asRow({ can_access_matchops: true }), config: () => ({ ok: true, config: { env: "staging", baseUrl: "https://matchday-stage.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } }) });
      const route = (p: string) => import(resolve(process.cwd(), p)) as Promise<Record<string, (r: Request, c: unknown) => Promise<Response>>>;
      const run = async (fn: () => Promise<Response>) => { seen.length = 0; const r = await fn(); return { status: r.status, verdict: (await r.clone().json()).verdict, seen: [...seen] }; };
      const act = await route("src/app/api/offers/[id]/[action]/route.ts");
      const one = await route("src/app/api/offers/[id]/route.ts");
      const list = await route("src/app/api/offers/route.ts");
      const C = "/admin/offers/campaigns/9";
      const ctx = (action?: string) => ({ params: Promise.resolve({ id: "9", action }) });
      const POSTREQ = () => new Request("http://localhost/x", { method: "POST", headers: { Authorization: "Bearer t" } });
      slept.length = 0;
      await run(() => one.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: { Authorization: "Bearer t" }, body: JSON.stringify({ name: "y" }) }), ctx()));
      await list.GET(new Request("http://localhost/api/offers"), {});
      eq("reads still wait out the 2 seconds", slept.length >= 1 && slept.every((ms) => ms > 1900 && ms <= 2000), true);
      current = campaign();
      const load = await run(() => list.GET(new Request("http://localhost/api/offers"), {}));
      eq("page load: one read for the page, one for the picker's matches, in that order", [load.status, load.seen, most], [200, ["GET /admin/offers/page", "GET /admin/offers/matches"], 1]);
      const loaded = await (await list.GET(new Request("http://localhost/api/offers"), {})).json();
      eq("...cut down, with each city's zone as the launch check wants it", [loaded.cities, loaded.fields], [[{ id: 2, name: "Houston", timeZone: "America/Chicago" }], [{ id: 1, title: "F", cityId: 2, cover: null }]]);
      eq("pause: the write and nothing else", await run(() => act.POST(POSTREQ(), ctx("pause"))), { status: 200, verdict: "LANDED", seen: [`POST ${C}/pause`] });
      eq("...and the log agrees", rows.at(-1)?.outcome, "landed");
      current = campaign({ status: "DRAFT" });
      eq("launch: the write and nothing else", await run(() => act.POST(POSTREQ(), ctx("launch"))), { status: 200, verdict: "LANDED", seen: [`POST ${C}/launch`] });
      current = campaign({ status: "DRAFT", matchIds: [116] });
      eq("launch for a match: the same", (await run(() => act.POST(POSTREQ(), ctx("launch")))).seen, [`POST ${C}/launch`]);
      current = campaign({ status: "DRAFT" });
      backendRefuses = true;
      const refused = await act.POST(POSTREQ(), ctx("launch"));
      const refusedBody = await refused.json();
      eq("the backend refuses a launch: FAILED, in its own words", [refused.status, refusedBody.verdict, refusedBody.error], [502, "FAILED", "The backend refused it: its end has already passed. Nothing was saved."]);
      backendRefuses = false;
      // The write's own answer is still checked, not just its 2xx.
      current = campaign({ status: "DRAFT" });
      answerStatus = "DRAFT";
      eq("a 2xx whose campaign shows no move: NOT APPLIED, not LANDED, in the route and the log", [(await run(() => act.POST(POSTREQ(), ctx("launch")))).verdict, rows.at(-1)?.outcome], ["NOT APPLIED", "notapplied"]);
      answerStatus = null;
      answerEmpty = true;
      eq("a 2xx with no campaign in it: unknown in the route and the log", [(await run(() => act.POST(POSTREQ(), ctx("launch")))).verdict, rows.at(-1)?.outcome], ["UNKNOWN", "unknown"]);
      seen.length = 0;
      const noSent = await sendPreview(auth, 9, [7]);
      eq("a test whose answer names nobody: unknown in the route and the log", [(await noSent.json()).verdict, rows.at(-1)?.outcome], ["UNKNOWN", "unknown"]);
      answerEmpty = false;
      current = campaign({ status: "DRAFT" });
      eq("an edit: one read first, for the log's before values, then the write", await run(() => one.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: { Authorization: "Bearer t" }, body: JSON.stringify({ name: "y" }) }), ctx())), { status: 200, verdict: "LANDED", seen: [`GET ${C}`, `PATCH ${C}`] });
      seen.length = 0;
      await list.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ name: "x", cityIds: [2] }) }), {});
      eq("a create: the write and nothing else", seen, ["POST /admin/offers/campaigns"]);
      current = campaign({ status: "DRAFT" });
      seen.length = 0;
      let gone = false;
      const realStub = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.pathname === "/auth/signin") return new Response(JSON.stringify({ accessToken: JWT }), { status: 200 });
        seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (init?.method === "DELETE") { gone = true; return new Response(null, { status: 204 }); }
        return gone ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(current), { status: 200 });
      }) as typeof fetch;
      eq("a delete returns nothing, so it alone is read back", await run(() => one.DELETE(new Request("http://localhost/x", { method: "DELETE", headers: { Authorization: "Bearer t" } }), ctx())), { status: 200, verdict: "LANDED", seen: [`GET ${C}`, `DELETE ${C}`, `GET ${C}`] });
      globalThis.fetch = realStub;
      _setOffersGateDepsForTest({ sleep, logStore, config: () => ({ ok: true, config: { env: "staging", baseUrl: "https://matchday-stage.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } }) });
      // A route the backend doesn't have can answer 200 with a web page.
      globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).endsWith("/auth/signin") ? new Response(JSON.stringify({ accessToken: JWT }), { status: 200 }) : new Response("<!DOCTYPE html>", { status: 200, headers: { "content-type": "text/html" } }))) as typeof fetch;
      eq("a web page where JSON should be says Offers may not be there", await offersGetText(), "The backend answered with something that isn't JSON. Offers may not be deployed there.");
      // That failure stopped reads, as any non-4xx does. Move past the stop for what follows.
      _setOffersGateDepsForTest({ sleep, logStore, now: () => Date.now() + 60_000, config: () => ({ ok: true, config: { env: "staging", baseUrl: "https://matchday-stage.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } }) });
      // A BACKEND WITHOUT OFFERS (review 2026-11-02): a page read 404s with no errorCode, Nest's own body or the local
      // build's. Said plainly, not the generic text. An Offers 404 carries its errorCode and keeps its own words (the control).
      const answer404 = (body: string) => { globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).endsWith("/auth/signin") ? new Response(JSON.stringify({ accessToken: JWT }), { status: 200 }) : new Response(body, { status: 404 }))) as typeof fetch; };
      const reads: string[] = [];
      for (const body of [JSON.stringify({ message: "Cannot GET /api/v1/admin/offers/matches", error: "Not Found", statusCode: 404 }), JSON.stringify({ message: "Not Found" }), "Not Found",
        JSON.stringify({ errorCode: "NOT_FOUND_OFFER_CAMPAIGN", message: "Offer campaign not found", statusCode: 404 })]) { answer404(body); reads.push(await offersGetText()); }
      eq("a page read 404 with no errorCode: Offers isn't deployed; with one: its own words", reads, [NO_OFFERS, NO_OFFERS, NO_OFFERS, "That offer no longer exists. Refresh the list."]);
      eq("...only for a read under /admin/offers: a write 404 and another read 404 stay generic", [
        errorText(new WriteFailedError(404, "PUT https://x.test/api/v1/admin/offers/campaigns/9: HTTP 404", "{\"message\":\"Not Found\"}")),
        errorText(new WriteFailedError(404, "GET https://x.test/api/v1/admin/matches/9: HTTP 404", "{\"message\":\"Not Found\"}")),
      ], [GENERIC, GENERIC]);
      globalThis.fetch = realStub;
    }

    // THE MATCH READS, on the real functions: one page on load, a paced walk only when asked, and never admin/matches.
    {
      const urls: string[] = [];
      let pages = 7, failAt = 0;
      await new Promise((r) => setTimeout(r, 0));
      const row = (id: number) => ({ id, name: `M${id}`, startsLocal: "2026-11-02 19:00:00", fieldId: 1, fieldName: "F", cityId: 1, price: 900, playersIn: 1, capacity: 16, minimum: 14 });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/auth/signin")) return new Response(JSON.stringify({ accessToken: JWT }), { status: 200 });
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        if (failAt && page === failAt) return new Response("{}", { status: 503 });
        return new Response(JSON.stringify({ page, limit: 100, totalItems: pages * 100, data: Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1)) }), { status: 200 });
      }) as typeof fetch;
      const first = await readFirstMatchPage();
      eq("page load: exactly one request", urls.length, 1);
      eq("...to the new endpoint, with the range and the limit", [new URL(urls[0]).pathname, new URL(urls[0]).searchParams.get("limit"), new URL(urls[0]).searchParams.has("from"), new URL(urls[0]).searchParams.has("to")], ["/admin/offers/matches", "100", true, true]);
      eq("...and says it wasn't all of them", [first.matches.length, first.complete], [100, false]);
      urls.length = 0;
      pages = 2;
      slept.length = 0;
      const two = await readMatchesForCities([1, 2]);
      eq("a walk asks for those cities, and stops when it has them all", [urls.length, new URL(urls[0]).searchParams.get("cityIds"), two.matches.length, two.complete], [2, "1,2", 200, true]);
      eq("...each read waiting out the 2 seconds", slept.length >= 1 && slept.every((ms) => ms > 1900 && ms <= 2000), true);
      urls.length = 0;
      pages = MAX_MATCH_PAGES + 2;
      const capped = await readMatchesForCities([]);
      eq("a walk stops at its cap and says so", [urls.length, capped.complete], [MAX_MATCH_PAGES, false]);
      urls.length = 0;
      failAt = 2;
      eq("a walk stops at the first error", [await readMatchesForCities([]).then(() => "read", () => "threw"), urls.length], ["threw", 2]);
      eq("...and the next read makes no request (the pacer's stop)", [await readMatchesForCities([]).catch((e) => e.name), urls.length], [READS_STOPPED, 2]);
      eq("no read here ever touched admin/matches", urls.some((u) => new URL(u).pathname === "/admin/matches"), false);
    }
    globalThis.fetch = realFetch;
    _setOffersGateDepsForTest(null);
  }


  // THE PUSH ROUTES, real handlers, fetch stubbed: nothing leaves this process.
  {
    const realFetch2 = globalThis.fetch;
    const JWT2 = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64")}.y`;
    const seen: { m: string; path: string; body: string | null; staff: string | null }[] = [];
    let answer: (path: string, m: string, body: unknown) => Response = () => new Response("{}", { status: 200 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/auth/signin") return new Response(JSON.stringify({ accessToken: JWT2 }), { status: 200 });
      const body = typeof init?.body === "string" ? init.body : null;
      seen.push({ m: init?.method ?? "GET", path: url.pathname, body, staff: new Headers(init?.headers).get("X-Acting-Staff-Email") });
      return answer(url.pathname, init?.method ?? "GET", body ? JSON.parse(body) : null);
    }) as typeof fetch;
    const rows2: { source: string; outcome: string; body: unknown }[] = [];
    const store2 = () => ({ insert: async (r: unknown) => { rows2.push(r as (typeof rows2)[number]); }, resolve: async () => undefined, recent: async () => [] }) as never;
    const stage = () => ({ ok: true as const, config: { env: "staging" as const, baseUrl: "https://matchday-stage.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } });
    const prod = () => ({ ok: true as const, config: { env: "production" as const, baseUrl: "https://playmatchday.herokuapp.com", uploadHost: "b.s3.amazonaws.com" } });
    Object.assign(process.env, { MATCHDAY_STAGE_API_BASE_URL: "https://matchday-stage.herokuapp.com", MATCHDAY_STAGE_API_EMAIL: "s@example.com", MATCHDAY_STAGE_API_PASSWORD: "x" });
    delete process.env.OFFERS_PUSH_ACCOUNTS;
    const asStaff = asRow({ can_access_matchops: true }, "staff@playmatchday.com");
    _setOffersGateDepsForTest({ sleep: async () => undefined, logStore: store2, authenticate: asStaff, config: stage, now: () => Date.now() + 120_000 });
    const mod = (p: string) => import(resolve(process.cwd(), p)) as Promise<Record<string, (r: Request, c: unknown) => Promise<Response>>>;
    const put = await mod("src/app/api/offers/[id]/push/route.ts");
    const test = await mod("src/app/api/offers/[id]/push/test/route.ts");
    const reach = await mod("src/app/api/offers/[id]/push/reachable/route.ts");
    const results = await mod("src/app/api/offers/[id]/push/results/route.ts");
    const settings = await mod("src/app/api/offers/push-settings/route.ts");
    const ctx = { params: Promise.resolve({ id: "9" }) };
    const req = (m: string, body?: unknown) => new Request("http://localhost/x", { method: m, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = async (r: Response) => ({ status: r.status, ...(await r.json()) });
    const campaignWith = (push: unknown) => new Response(JSON.stringify({ id: 9, status: "DRAFT", push }), { status: 200 });
    const want = { enabled: true, title: "50% OFF", body: "{first_name}, 50% off your next match.", sendLocal: "2026-11-03 10:00" };
    answer = (_p, _m, b) => campaignWith({ ...(b as object), status: "WAITING", queuedAt: null });
    seen.length = 0;
    const saved = await json(await put.PUT(req("PUT", want), ctx));
    eq("save: one PUT with the push, LANDED on the campaign it returns", [saved.status, saved.verdict, seen.map((x) => `${x.m} ${x.path}`), JSON.parse(seen[0].body!)], [200, "LANDED", ["PUT /admin/offers/campaigns/9/push"], want]);
    eq("...as a logged write, with the staff header", [rows2.at(-1)?.source, rows2.at(-1)?.outcome, seen[0].staff], ["offers:push", "landed", "staff@playmatchday.com"]);
    answer = () => campaignWith({ ...want, title: "Something else", status: "WAITING", queuedAt: null });
    eq("a 2xx whose push differs: NOT APPLIED", (await json(await put.PUT(req("PUT", want), ctx))).verdict, "NOT APPLIED");
    answer = () => new Response("{}", { status: 200 });
    eq("a 2xx with no campaign: unknown, in the route and the log", [(await json(await put.PUT(req("PUT", want), ctx))).verdict, rows2.at(-1)?.outcome], ["UNKNOWN", "unknown"]);
    answer = () => new Response(JSON.stringify({ errorCode: "OFFER_PUSH_LOCKED", message: "Offer push is locked: queued" }), { status: 400 });
    eq("queued already: said plainly", (await json(await put.PUT(req("PUT", want), ctx))).error, "The push is already queued, so it can't change now. Nothing was saved.");
    answer = () => new Response(JSON.stringify({ message: "Cannot PUT /admin/offers/campaigns/9/push", error: "Not Found", statusCode: 404 }), { status: 404 });
    eq("a backend without pushes: said plainly", (await json(await put.PUT(req("PUT", want), ctx))).error, "This backend doesn't have offer pushes yet, so nothing was sent or saved.");
    seen.length = 0;
    eq("a bad push is refused before any request", [(await json(await put.PUT(req("PUT", { ...want, title: "" }), ctx))).status, (await json(await put.PUT(req("PUT", { title: "x" }), ctx))).status, seen.length], [400, 400, 0]);
    answer = () => campaignWith({ enabled: false, title: null, body: null, sendLocal: null, status: "OFF", queuedAt: null });
    eq("off sends only enabled false", [(await json(await put.PUT(req("PUT", { enabled: false, title: "ignored" }), ctx))).verdict, JSON.parse(seen.at(-1)!.body!)], ["LANDED", { enabled: false }]);
    // THE TEST: only text goes, never who.
    answer = () => new Response(JSON.stringify({ pushId: 9081, devices: 2, sent: 2, failed: 0 }), { status: 201 });
    seen.length = 0;
    const t = await json(await test.POST(req("POST", { title: "Hi", body: "There", userIds: [7, 8], email: "someone@else.com", tokens: ["abc"] }), ctx));
    eq("test: SENT, to the phones the backend names", [t.verdict, t.sent, t.devices], ["SENT", 2, 2]);
    eq("...the request carries only the text, and the signed-in person as staff", [seen.map((x) => `${x.m} ${x.path}`), JSON.parse(seen[0].body!), seen[0].staff], [["POST /admin/offers/campaigns/9/push/test"], { title: "Hi", body: "There" }, "staff@playmatchday.com"]);
    eq("...and is logged as the test it is", [rows2.at(-1)?.source, rows2.at(-1)?.outcome], ["offers:push-test", "landed"]);
    answer = () => new Response(JSON.stringify({ errorCode: "NOT_FOUND_PREVIEW_PLAYER", message: "x" }), { status: 404 });
    eq("no player account for that email: said", (await json(await test.POST(req("POST", {}), ctx))).error, "No player account in the app uses staff@playmatchday.com. Sign up in the app with that email, then try again.");
    answer = () => new Response("{}", { status: 201 });
    eq("a 2xx that names no phones: UNKNOWN", (await json(await test.POST(req("POST", {}), ctx))).verdict, "UNKNOWN");
    // READS.
    answer = () => new Response(JSON.stringify({ audience: 1240, heldBack: 118, noConsent: 402, noDevice: 61, capped: 23, reachable: 636 }), { status: 200 });
    seen.length = 0;
    eq("reach: one GET, passed through", [(await json(await reach.GET(req("GET"), ctx))).reachable, seen.map((x) => `${x.m} ${x.path}`)], [636, ["GET /admin/offers/campaigns/9/push/reachable"]]);
    answer = () => new Response(JSON.stringify({ status: "SENT", sent: 612, failed: 4, skipped: { heldBack: 118, noConsent: 402, noDevice: 61, capped: 23, notAllowed: 0 }, opened: 97, bookedWithin72h: 41, devices: 701 }), { status: 200 });
    eq("results: passed through", (await json(await results.GET(req("GET"), ctx))).bookedWithin72h, 41);
    // A push route answered 200 with a web page: no pushes, on that card, and the next read still goes.
    const resultsOk = answer;
    answer = (p) => (p.endsWith("/push/reachable") ? new Response("<!DOCTYPE html>", { status: 200, headers: { "content-type": "text/html" } }) : resultsOk(p, "GET", null));
    seen.length = 0;
    const html = await json(await reach.GET(req("GET"), ctx));
    eq("a web page on a push read: no pushes here, and reads aren't stopped (results read straight after)", [html.status, html.error, (await json(await results.GET(req("GET"), ctx))).bookedWithin72h, seen.map((x) => x.path)],
      [502, "This backend doesn't have offer pushes yet, so nothing was sent or saved.", 41, ["/admin/offers/campaigns/9/push/reachable", "/admin/offers/campaigns/9/push/results"]]);
    // THE WEEKLY LIMIT.
    answer = (_p, m, b) => new Response(JSON.stringify(m === "PUT" ? b : { weeklyCap: 2 }), { status: 200 });
    eq("limit: read, then saved and LANDED", [(await json(await settings.GET(req("GET"), {}))).weeklyCap, (await json(await settings.PUT(req("PUT", { weeklyCap: 3 }), {}))).verdict, rows2.at(-1)?.source], [2, "LANDED", "offers:push-settings"]);
    answer = () => new Response(JSON.stringify({ message: "Not Found", statusCode: 404 }), { status: 404 });
    eq("a backend without pushes that says only Not Found (the local build): said plainly", (await json(await settings.GET(req("GET"), {}))).error, "This backend doesn't have offer pushes yet, so nothing was sent or saved.");
    answer = (_p, m, b) => new Response(JSON.stringify(m === "PUT" ? b : { weeklyCap: 2 }), { status: 200 });
    seen.length = 0;
    eq("limit outside 0 to 14: refused, no request", [(await json(await settings.PUT(req("PUT", { weeklyCap: 15 }), {}))).status, (await json(await settings.PUT(req("PUT", { weeklyCap: -1 }), {}))).status, (await json(await settings.PUT(req("PUT", { weeklyCap: 1.5 }), {}))).status, seen.length], [400, 400, 400, 0]);
    answer = () => new Response(JSON.stringify({ weeklyCap: 2 }), { status: 200 });
    eq("limit answered with another number: NOT APPLIED", (await json(await settings.PUT(req("PUT", { weeklyCap: 4 }), {}))).verdict, "NOT APPLIED");
    // PRODUCTION: hidden, every push route answers as missing and sends nothing.
    _setOffersGateDepsForTest({ sleep: async () => undefined, logStore: store2, authenticate: asStaff, config: prod, now: () => Date.now() + 120_000 });
    seen.length = 0;
    const hidden = [await put.PUT(req("PUT", want), ctx), await test.POST(req("POST", {}), ctx), await reach.GET(req("GET"), ctx), await results.GET(req("GET"), ctx), await settings.GET(req("GET"), {}), await settings.PUT(req("PUT", { weeklyCap: 2 }), {})].map((r) => r.status);
    eq("production: every push route is 404, and nothing reaches the backend", [hidden, seen.length], [[404, 404, 404, 404, 404, 404], 0]);
    process.env.OFFERS_PUSH_ACCOUNTS = "staff@playmatchday.com";
    answer = () => new Response(JSON.stringify({ audience: 1, heldBack: 0, noConsent: 0, noDevice: 0, capped: 0, reachable: 1 }), { status: 200 });
    Object.assign(process.env, { MATCHDAY_PROD_BASE_URL: "https://playmatchday.herokuapp.com", MATCHDAY_PROD_API_EMAIL: "p@example.com", MATCHDAY_PROD_API_PASSWORD: "x" });
    eq("...except for a listed account (the control)", (await reach.GET(req("GET"), ctx)).status, 200);
    delete process.env.OFFERS_PUSH_ACCOUNTS;
    globalThis.fetch = realFetch2;
    _setOffersGateDepsForTest(null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass === 0 || fail > 0) process.exit(1);
})();
