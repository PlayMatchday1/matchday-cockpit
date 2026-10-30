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

import { offersAccessState, onOffersAllowlist } from "../src/lib/offersAccess";
import {
  audienceBody, chicagoWallNow, comparisonLine, costCeiling, createBody, defaultRun, endsTicket, formOf, newForm, patchBody, priceWithDeal,
  summary, wallFromMatch, withPreviewName, buttonOf, opensText, formProblem, stepUses, usesLine, stepLimit, limitLine, copyOf,
  addSection, autoCopy, canReset, isRemovable, removeSection, resetCopy, sectionCollapsed, REMOVABLE_KEYS, canHidePhoto, copyAfterHide, hideUpload, extraBookingsLine, photoContentType, photoFileProblem, photoUrlOk, settableHeaders, uploadTiles, prefillField, audienceText, parsePlayerIds, playerLine, notFoundLine, usedOfLimit, resultsLines, type Campaign, type City, type MatchOpt, type Results,
} from "../src/lib/offersModel";
import { _setOffersGateDepsForTest, mismatches, offersGate, photoLinkProblem } from "../src/lib/offersServer";

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
  eq("a draft loaded and not touched sends nothing", patchBody(c, formOf(c), matches, cities), {});
  const f = formOf(c);
  eq("changing the percent sends dealAmount only", patchBody(c, { ...f, dealAmount: 40 }, matches, cities), { dealAmount: 40 });
  eq("LAPSED to Any time clears lastPlayedDays explicitly (else the merged row is invalid)",
    patchBody(c, { ...f, lastPlayed: "ANY", lastPlayedDays: null }, matches, cities), { lastPlayed: "ANY", lastPlayedDays: null });
  const typed = { ...f, copy: { headline: "HALF OFF" } };
  const c2 = { ...c, headline: "HALF OFF" };
  eq("typed copy survives a reload and is not re-sent", patchBody(c2, formOf(c2), matches, cities), {});
  eq("typed copy is sent as typed", patchBody(c, typed, matches, cities), { headline: "HALF OFF" });
  const old = { ...c, caption: null };
  eq("a stored 'no caption' (saved before captions) loads and sends nothing", patchBody(old, formOf(old), matches, cities), {});
  eq("the lapsed eyebrow carries {firstName} for the backend to fill", createBody(f, matches, cities).eyebrow, "WE MISS YOU, {firstName}");
  eq("the preview shows {firstName} as Luis", withPreviewName("WE MISS YOU, {firstName}"), "WE MISS YOU, Luis");
  eq("an emptied headline stays empty and stops the save", [copyOf({ ...f, copy: { headline: "" } }, matches, cities).headline, formProblem({ ...f, copy: { headline: "  " } }, matches)], ["", "The popup needs a headline."]);
  eq("Reset to suggested on a typed headline sends the deal's text", patchBody(c2, { ...formOf(c2), copy: resetCopy(formOf(c2).copy, "headline", "50% OFF", true) }, matches, cities), { headline: "50% OFF" });
}
{
  const c = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  const f = formOf(c);
  const sent = patchBody(c, { ...f, dealType: "FREE_MATCH", dealAmount: 0, cityIds: [2], holdoutPercent: 0, endsLocal: "2026-12-01 00:00:00", name: "Austin back", maxRedemptions: 50 }, matches, cities);
  eq("after launch a locked field is never sent, only name and cap (the text does not move with the deal)", Object.keys(sent).sort(), ["maxRedemptions", "name"]);
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
  eq("its opens line", opensText({ ...nowF, buttonTarget: "MATCH", buttonMatchId: 117 }, matches), "↳ Opens Tue 7:00 PM · Mueller Park");
  eq("a button match not picked yet stops the save", formProblem({ ...nowF, name: "x", buttonTarget: "MATCH", buttonMatchId: null }, matches), "Pick the match the button opens.");
  const live = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  const lf = formOf(live);
  eq("after launch, pointing the button at a match sends only the target fields",
    patchBody(live, { ...lf, buttonTarget: "MATCH", buttonMatchId: 117 }, matches, cities), { buttonTarget: "MATCH", buttonMatchId: 117 });
  const live2 = { ...live, buttonTarget: "MATCH" as const, buttonMatchId: 117 };
  eq("after launch, back to Find a match clears buttonMatchId and sends nothing else",
    patchBody(live2, { ...formOf(live2), buttonTarget: "FIND_MATCH", buttonMatchId: null }, matches, cities), { buttonTarget: "FIND_MATCH", buttonMatchId: null });
  eq("a launched offer with a match button loads and sends nothing", patchBody(live2, formOf(live2), matches, cities), {});
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
  eq("after launch, the limit is one of the fields still sent, alone", patchBody(live, { ...formOf(live), maxRedemptions: 80 }, matches, cities), { maxRedemptions: 80 });
  eq("after launch, back to no limit sends null", patchBody({ ...live, maxRedemptions: 80 }, { ...formOf({ ...live, maxRedemptions: 80 }), maxRedemptions: null }, matches, cities), { maxRedemptions: null });
}

console.log("photo:");
eq("any match: the default MatchDay photo (null)", copyOf({ ...nowF, name: "x" }, matches, cities).photoUrl, null);
eq("a specific match: that match's field cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116 }, matches, cities).photoUrl, "https://covers.local/riverside.jpg");
eq("a specific match with no cover: the default", copyOf({ ...nowF, scope: "MATCH", matchId: 117 }, matches, cities).photoUrl, null);
eq("a picked cover is sent as the photo", createBody({ ...nowF, name: "x", copy: { photoUrl: "https://covers.local/mueller.jpg" } }, matches, cities).photoUrl, "https://covers.local/mueller.jpg");
eq("picking MatchDay photo on a specific match sends no photo (null), not the cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116, copy: { photoUrl: null } }, matches, cities).photoUrl, null);
{
  const live = draftFrom({ status: "LAUNCHED", state: "LIVE" });
  eq("after launch, changing the photo sends only photoUrl", patchBody(live, { ...formOf(live), copy: { photoUrl: "https://covers.local/mueller.jpg" } }, matches, cities), { photoUrl: "https://covers.local/mueller.jpg" });
  const withPhoto = { ...live, photoUrl: "https://covers.local/mueller.jpg" };
  eq("a stored photo loads and sends nothing", patchBody(withPhoto, formOf(withPhoto), matches, cities), {});
}

console.log("played at:");
eq("picking a specific match prefills its field", prefillField([], matches[0]), [1]);
eq("...and keeps fields already there, without doubling", [prefillField([2], matches[0]), prefillField([1, 2], matches[0])], [[2, 1], [1, 2]]);
eq("fields are sent with or without a match", [createBody({ ...nowF, name: "x", fieldIds: [1, 2] }, matches, cities).fieldIds, audienceBody({ ...nowF, fieldIds: [2] }, matches, cities).fieldIds], [[1, 2], [2]]);
eq("the list line names them", audienceText({ ...draftFrom(), fieldIds: [1, 2], cityIds: [1] }, cities, [{ id: 1, title: "Riverside Fields", cityId: 1, cover: null }, { id: 2, title: "Mueller Park", cityId: 1, cover: null }]),
  "Austin · Not played in 30+ days · Played at Riverside Fields or Mueller Park");

console.log("specific players:");
eq("ids from commas, spaces and lines, first kept, junk set aside", parsePlayerIds("10482, 10511\n9877  10482,abc,0,-3"), { ids: [10482, 10511, 9877], bad: ["abc", "0", "-3"], tooMany: false });
eq("over the cap is flagged", parsePlayerIds("1 2 3", 2), { ids: [1, 2], bad: [], tooMany: true });
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
  eq("a stored players offer loads and sends nothing", patchBody(stored, formOf(stored), matches, cities), {});
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
eq("the link must be a PUT to the local backend (the control)", photoLinkProblem({ ...lk, uploadURL: "http://localhost:3070/dev/uploads/offers/photos/a.jpg" }), null);
eq("a spoofed host is refused on the parsed host", photoLinkProblem({ ...lk, uploadURL: "http://localhost:3070.evil.com/a.jpg" }) !== null, true);
eq("another host, a POST and no key are refused", [photoLinkProblem({ ...lk, uploadURL: "https://evil.com/a.jpg" }) !== null, photoLinkProblem({ ...lk, method: "POST", uploadURL: "http://localhost:3070/a" }) !== null, photoLinkProblem({ ...lk, fileKey: "", uploadURL: "http://localhost:3070/a" }) !== null, photoLinkProblem({ ...lk }) !== null], [true, true, true, true]);
{
  const up = [{ url: "https://x/a.jpg", name: "a.jpg" }, { url: "https://x/b.jpg", name: "b.jpg" }];
  eq("uploads stay as tiles", uploadTiles(up, null, []).map((p) => p.url), ["https://x/a.jpg", "https://x/b.jpg"]);
  eq("the saved photo is a tile even if this browser never saw it", uploadTiles(up, "https://x/c.jpg", []).map((p) => p.name), ["a.jpg", "b.jpg", "Saved photo"]);
  eq("a saved photo that is a cover or an upload is not doubled", [uploadTiles(up, "https://x/a.jpg", []).length, uploadTiles([], "https://x/cover.jpg", ["https://x/cover.jpg"]).length], [2, 0]);
  eq("the × takes only that tile off", hideUpload(up, "https://x/a.jpg").map((p) => p.name), ["b.jpg"]);
  eq("the saved photo has no ×, every other upload does", [canHidePhoto("https://x/a.jpg", "https://x/a.jpg"), canHidePhoto("https://x/b.jpg", "https://x/a.jpg"), canHidePhoto("https://x/b.jpg", null)], [false, true, true]);
  eq("a hidden saved-with photo would still be a tile (why it has no ×)", uploadTiles(hideUpload(up, "https://x/a.jpg"), "https://x/a.jpg", []).map((p) => p.url), ["https://x/b.jpg", "https://x/a.jpg"]);
  const A = "https://x/a.jpg", B = "https://x/b.jpg", COVER = "https://covers.local/riverside.jpg";
  eq("a new offer: hiding the selected photo goes to the default", copyOf({ ...nowF, copy: copyAfterHide({ photoUrl: A, headline: "HI" }, A, undefined) }, matches, cities).photoUrl, null);
  eq("...and leaves the other typed text alone", copyAfterHide({ photoUrl: A, headline: "HI" }, A, undefined), { headline: "HI" });
  eq("...on a specific match the default is its field cover", copyOf({ ...nowF, scope: "MATCH", matchId: 116, copy: copyAfterHide({ photoUrl: A }, A, undefined) }, matches, cities).photoUrl, COVER);
  eq("hiding a photo that is not selected changes nothing", copyAfterHide({ photoUrl: B }, A, B), { photoUrl: B });
  // Saved with A, then B picked and hidden: back to A, nothing to save.
  for (const [name, over] of [["a draft", {}], ["a launched offer", { status: "LAUNCHED", state: "LIVE" }], ["a paused offer", { status: "PAUSED", state: "PAUSED" }]] as const) {
    const c = draftFrom({ photoUrl: A, ...over } as Partial<Campaign>);
    const f = formOf(c);
    const picked = { ...f, copy: { ...f.copy, photoUrl: B } };
    eq(`${name} saved with a photo: picking another sends it (the control)`, patchBody(c, picked, matches, cities), { photoUrl: B });
    const back = { ...picked, copy: copyAfterHide(picked.copy, B, c.photoUrl) };
    eq(`${name}: hiding it goes back to the saved photo`, copyOf(back, matches, cities).photoUrl, A);
    eq(`${name}: and leaves nothing to save`, patchBody(c, back, matches, cities), {});
  }
  const none = draftFrom({ photoUrl: null });
  const nf = formOf(none);
  const nb = { ...nf, copy: copyAfterHide({ ...nf.copy, photoUrl: B }, B, null) };
  eq("saved with no photo: hiding goes to the default, nothing to save", [copyOf(nb, matches, cities).photoUrl, patchBody(none, nb, matches, cities)], [null, {}]);
  eq("...and it stays on that when a match with a cover is picked", copyOf({ ...nb, scope: "MATCH", matchId: 116 }, matches, cities).photoUrl, null);
  // Saved with no photo, on a specific match whose default is a cover: back to no photo, not the cover.
  const sc = draftFrom({ photoUrl: null, matchIds: [116], matchScoped: true, buttonTarget: "MATCH", buttonMatchId: 116, usesPerPlayer: 1, endsLocal: "2026-11-02 19:00:00" });
  const sf = formOf(sc);
  const sb = { ...sf, copy: copyAfterHide({ ...sf.copy, photoUrl: B }, B, null) };
  eq("saved with no photo where the default is a cover: back to saved, not the cover", [copyOf(sb, matches, cities).photoUrl, patchBody(sc, sb, matches, cities).photoUrl], [null, undefined]);
  // Another unsaved edit is still there to save; hiding only removes its own.
  const edited = draftFrom({ photoUrl: A });
  const ef = { ...formOf(edited), name: "New name" };
  eq("an unrelated unsaved edit survives hiding", patchBody(edited, { ...ef, copy: copyAfterHide({ ...ef.copy, photoUrl: B }, B, A) }, matches, cities), { name: "New name" });
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
    const f = formOf(c);
    const cut = { ...f, copy: removeSection(f.copy, "body") };
    eq(`${name}: Remove sends null for that section alone`, patchBody(c, cut, matches, cities), { body: null });
    const saved = { ...c, body: null };
    const sf = formOf(saved);
    eq(`${name}: a saved removal loads removed and sends nothing`, [sf.copy.body, sectionCollapsed(sf.copy, "body", autoCopy(sf, matches, cities).body), patchBody(saved, sf, matches, cities)], [null, true, {}]);
    eq(`${name}: + Add on a saved removal sends the suggested text`, patchBody(saved, { ...sf, copy: addSection(sf.copy, "body", undefined, autoCopy(sf, matches, cities).body, true) }, matches, cities), { body: "Any match in Austin. The discount is already on your account." });
    eq(`${name}: Remove then + Add on the same visit leaves nothing to save`, patchBody(c, { ...cut, copy: addSection(cut.copy, "body", f.copy.body ?? undefined, auto.body, true) }, matches, cities), {});
  }

  const typed = draftFrom({ eyebrow: "HEY THERE", status: "LAUNCHED", state: "LIVE" });
  const tf = formOf(typed);
  eq("typed text is the control: it loads as typed", tf.copy.eyebrow, "HEY THERE");
  const cutT = removeSection(tf.copy, "eyebrow");
  eq("Remove then + Add brings typed text back, nothing to save", patchBody(typed, { ...tf, copy: addSection(cutT, "eyebrow", "HEY THERE", auto.eyebrow, true) }, matches, cities), {});
  eq("Reset to suggested is offered on typed text", canReset(tf.copy, "eyebrow", auto.eyebrow), true);
  eq("Reset to suggested sends the deal's text after launch", patchBody(typed, { ...tf, copy: resetCopy(tf.copy, "eyebrow", auto.eyebrow, true) }, matches, cities), { eyebrow: auto.eyebrow });
  eq("not offered when following the deal, or on the suggestion itself", [canReset({}, "eyebrow", auto.eyebrow), canReset({ eyebrow: auto.eyebrow }, "eyebrow", auto.eyebrow)], [false, false]);
  eq("not offered with nothing to suggest", canReset({ caption: "typed" }, "caption", null), false);
  eq("offered on an emptied required field", canReset({ headline: "" }, "headline", "50% OFF"), true);

  // The photo line is the one section a deal can leave empty.
  const any = { ...nowF, name: "x" };
  eq("an any-match offer suggests no photo line, so it starts collapsed", [autoCopy(any, matches, cities).caption, sectionCollapsed(any.copy, "caption", null)], [null, true]);
  const opened = addSection(any.copy, "caption", undefined, null, false);
  eq("+ Add photo line opens an empty box", [opened.caption, sectionCollapsed(opened, "caption", null)], ["", false]);
  eq("left empty it still saves as null", "caption" in createBody({ ...any, copy: opened }, matches, cities) && createBody({ ...any, copy: opened }, matches, cities).caption === null, true);
  eq("with text typed it is sent", createBody({ ...any, copy: { caption: "See you there" } }, matches, cities).caption, "See you there");
  eq("a section with text is not collapsed (the control)", sectionCollapsed({}, "eyebrow", "JUST FOR YOU"), false);
  eq("button label empty stops the save", formProblem({ ...any, copy: { buttonLabel: "" } }, matches), "The popup needs a button label.");
  eq("all four removed saves (the control)", formProblem({ ...any, copy: gone }, matches), null);
}

console.log("saved text is fixed; changes only move what Reset to suggested gives:");
{
  const SUGGESTED_CAPTION = "Your spot at the field is waiting.";
  const lapse = { lastPlayed: "LAPSED" as const, lastPlayedDays: 30 };
  const pick = { scope: "MATCH" as const, matchId: 116, fieldIds: [1], endsLocal: "2026-11-02 19:00:00" };
  // The exact case: a draft saved with no photo line, reopened, then the audience or the match changes.
  const body = createBody({ ...nowF, name: "x", cityIds: [1], copy: { caption: null } }, matches, cities);
  const stored = { lastPlayedDays: null, maxMatches: null, maxRedemptions: null, buttonMatchId: null, photoUrl: null, matchIds: [], playerIds: [], fieldIds: [], ...body, id: 9, matchScoped: false, status: "DRAFT", state: "DRAFT", results } as unknown as Campaign;
  const f = formOf(stored);
  for (const [name, change] of [["audience changed to lapsed", lapse], ["a specific match picked", pick]] as const) {
    const moved = { ...f, ...change };
    const offered = autoCopy(moved, matches, cities).caption;
    eq(`${name}: the deal does suggest a photo line now (the control)`, offered === null, false);
    eq(`${name}: the photo line stays removed`, [copyOf(moved, matches, cities).caption, sectionCollapsed(moved.copy, "caption", offered)], [null, true]);
    eq(`${name}: no photo line is sent`, "caption" in patchBody(stored, moved, matches, cities), false);
    eq(`${name}: + Add brings the current suggestion`, addSection(moved.copy, "caption", undefined, offered, true).caption, offered);
  }
  eq("the suggestion for lapsed is the one the deal writes", autoCopy({ ...f, ...lapse }, matches, cities).caption, SUGGESTED_CAPTION);

  const text = (["eyebrow", "caption", "headline", "line", "body", "buttonLabel", "dismissLabel", "photoUrl"] as const);
  const asSaved = (g: typeof f) => text.map((k) => copyOf(g, matches, cities)[k]);
  const before = asSaved(f);
  eq("a new percent moves no saved text", asSaved({ ...f, dealAmount: 40 }), before);
  eq("a new deal type moves no saved text", asSaved({ ...f, dealType: "FREE_MATCH", dealAmount: 0 }), before);
  eq("a new audience moves no saved text", asSaved({ ...f, ...lapse, cityIds: [2] }), before);
  eq("a picked match moves no saved text or photo", asSaved({ ...f, ...pick }), before);
  eq("the same deal change sends the deal alone", patchBody(stored, { ...f, dealAmount: 40 }, matches, cities), { dealAmount: 40 });
  eq("the same match pick sends no text", Object.keys(patchBody(stored, { ...f, ...pick }, matches, cities)).filter((k) => text.includes(k as (typeof text)[number])), []);

  const forty = { ...f, dealAmount: 40 };
  const s40 = autoCopy(forty, matches, cities).headline;
  eq("Reset to suggested is offered once the deal moves on, with the new text", [canReset(f.copy, "headline", autoCopy(f, matches, cities).headline), canReset(forty.copy, "headline", s40), s40], [false, true, "40% OFF"]);
  const reset = { ...forty, copy: resetCopy(forty.copy, "headline", s40, true) };
  eq("Reset takes that text and sends it", patchBody(stored, reset, matches, cities), { dealAmount: 40, headline: "40% OFF" });
  eq("and it does not move again with the next change", copyOf({ ...reset, dealAmount: 30 }, matches, cities).headline, "40% OFF");
  const added = { ...f, ...lapse, copy: addSection(f.copy, "caption", undefined, SUGGESTED_CAPTION, true) };
  eq("text from + Add does not move with the next change either", copyOf({ ...added, lastPlayed: "ANY" as const, lastPlayedDays: null }, matches, cities).caption, SUGGESTED_CAPTION);

  const fresh = { ...nowF, name: "x" };
  eq("before the first save the text follows the deal", copyOf({ ...fresh, dealAmount: 40 }, matches, cities).headline, "40% OFF");
  eq("before the first save the photo line follows the audience", copyOf({ ...fresh, ...lapse }, matches, cities).caption, SUGGESTED_CAPTION);
  eq("before the first save a removed section still stays removed", copyOf({ ...fresh, ...lapse, copy: { caption: null } }, matches, cities).caption, null);
  eq("before the first save Reset follows the deal again", copyOf({ ...fresh, dealAmount: 40, copy: resetCopy({ headline: "TYPED" }, "headline", "50% OFF", false) }, matches, cities).headline, "40% OFF");
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

console.log("extra bookings:");
{
  const at = (wP: number, wB: number, hP: number, hB: number, discount: number) => ({ ...results, discountGiven: discount,
    booked: { withOffer: { players: wP, booked: wB, rate: wP ? wB / wP : null }, heldBack: { players: hP, booked: hB, rate: hP ? hB / hP : null } } });
  // 37 x (10/37 - 4/40) = 10 - 3.7 = 6.3, so 6; $54 / 6 = $9.
  eq("N and X", extraBookingsLine(at(37, 10, 40, 4, 5400), "FILTERS"), "About 6 extra bookings · $9 in discounts per extra booking");
  // 100 x (0.2 - 0.1) = 10; $25 / 10 = $2.50, which rounds to the dollar.
  eq("X rounds to the dollar", extraBookingsLine(at(100, 20, 30, 3, 2500), "FILTERS"), "About 10 extra bookings · $3 in discounts per extra booking");
  eq("one extra booking is singular", extraBookingsLine(at(10, 2, 30, 3, 1000), "FILTERS"), "About 1 extra booking · $10 in discounts per extra booking");
  eq("the same rate is no extra bookings, and no cost", extraBookingsLine(at(100, 10, 30, 3, 5000), "FILTERS"), "No extra bookings so far");
  eq("a worse rate than held back is no extra bookings", extraBookingsLine(at(100, 5, 30, 3, 5000), "FILTERS"), "No extra bookings so far");
  eq("an N that rounds to 0 is no extra bookings, not a divide by zero", extraBookingsLine(at(10, 1, 30, 2, 5000), "FILTERS"), "No extra bookings so far");
  eq("exactly 30 held back shows it", extraBookingsLine(at(100, 20, 30, 3, 1000), "FILTERS") !== null, true);
  eq("29 held back hides it", extraBookingsLine(at(100, 20, 29, 3, 1000), "FILTERS"), null);
  eq("the fixture's 3 held back hides it", extraBookingsLine(at(37, 10, 3, 1, 5400), "FILTERS"), null);
  eq("Specific players hides it, whatever the numbers", extraBookingsLine(at(100, 20, 40, 3, 1000), "PLAYERS"), null);
  eq("no rate for the offer group hides it", extraBookingsLine(at(0, 0, 40, 3, 0), "FILTERS"), null);
}

console.log("access:");
eq("unset list is nobody", onOffersAllowlist("rmancuso@playmatchday.com", {}), false);
eq("on the list, any case", onOffersAllowlist("RMancuso@PlayMatchday.com", { OFFERS_ALLOWLIST: " rmancuso@playmatchday.com " }), true);
eq("another admin is not on it", onOffersAllowlist("someone@playmatchday.com", { OFFERS_ALLOWLIST: "rmancuso@playmatchday.com" }), false);

eq("a 401 is an ended sign-in, not a 404", offersAccessState(401, { error: "Invalid session" }), "signin");
eq("a 200 yes is yes (the control)", offersAccessState(200, { allowed: true }), "yes");
eq("off the list, not an admin, local mode off and a strange 200 are all no",
  [offersAccessState(404, { error: "Not found" }), offersAccessState(403, { error: "x" }), offersAccessState(503, { error: "x" }), offersAccessState(200, { allowed: "yes" }), offersAccessState(200, null)], ["no", "no", "no", "no", "no"]);

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
