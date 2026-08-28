/* FIELDS — the guard on the field write model.
 *
 * WHY IT IS A NODE GUARD and not a browser look: a field record decides what a match says it was
 * played on. A wrong recommendedPlayerCount is stored silently and reads as a plausible number,
 * and a create body carrying one extra key is a 400 that kills the whole create.
 *
 * Every constant here was measured against the API on 2026-08-28 — staging for writes, production
 * for reads. Where a number appears it is a real one.
 */

import { readFileSync } from "node:fs";
import {
  FORMATS, formatTotal, formatShort, formatLabel, recommendationReadout,
  createBody, updateBody, CREATE_KEYS, UPDATE_KEYS, SERVER_REQUIRED, missingRequired,
  coerceZip, deleteBlock, deleteConfirmed, validPhone, isMapped, unmappedSummary, orphanLinks,
  phoneAuditNote, IMAGE_HOST,
} from "../src/lib/fieldsModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\nformat sends the TOTAL, not the per-side number");
{
  /* THE WHOLE POINT OF THIS SUITE. recommendedPlayerCount is a TOTAL: a 9 v 9 pitch stores 18.
   * The mockup carried per-side values and rendered 9 as "9 × 9"; saving that would have stored 9
   * on every 9v9 field in the network — a number that is not wrong-looking, just wrong. */
  is("choosing the 9 v 9 option sends 18", formatTotal(9), 18);
  /* THE CONTROL. This assertion has to be able to fail on the value it is guarding against, or it
   * is not guarding anything: 18 must NOT equal 9. */
  if (formatTotal(9) !== 9) ok("control: 18 is not 9 — the assertion can fail on the per-side value");
  else bad("control: the assertion can fail on 9", "formatTotal returned the per-side number");

  is("7 v 7 sends 14", formatTotal(7), 14);
  is("8 v 8 sends 16", formatTotal(8), 16);
  is("10 v 10 sends 20", formatTotal(10), 20);
  is("11 v 11 sends 22", formatTotal(11), 22);
  is("an option nobody offers has no total", formatTotal(6), null);

  /* THE FIVE PRODUCTION VALUES, ALL OF THEM. Measured: 14×3 fields, 16×8, 18×23, 20×1, 22×9. A
   * dropdown offering only 8/9/11 would silently rewrite the three 7v7s and the one 10v10 the
   * first time anyone opened and saved them. */
  is("every production value is offered", FORMATS.map((f) => f.total), [14, 16, 18, 20, 22]);
  is("all five are even, because a total splits into two sides",
    FORMATS.every((f) => f.total % 2 === 0 && f.total === f.perSide * 2), true);

  // THE LABEL CARRIES BOTH READINGS so nobody has to remember which one is stored.
  is("the label names the per-side form and the stored number", FORMATS[2].label, "9 v 9 · 18 players");
  is("…and the stored number is the one after the dot", FORMATS[2].total, 18);
  is("the list column reads per-side", formatShort(18), "9 v 9");
  is("an unrecognised total is shown, not guessed at", formatShort(17), "17 total");
  is("…and labelled the same way", formatLabel(17), "17 players");
  is("nothing renders as a blank", formatShort(null), "—");
}

console.log("\ncapacity is a RECOMMENDATION, not a cap");
{
  /* MEASURED: 6 fields run every match at their own rpc and 23 DO NOT. Field 1486 stores 22 and
   * runs matches at 18, 20, 22, 28, 32 and 36. The match record is authoritative. */
  const r = recommendationReadout(18, 1);
  if (/default/i.test(r)) ok("the readout says DEFAULT");
  else bad("the readout says DEFAULT", r);
  if (/each match sets its own/i.test(r)) ok("…and that each match sets its own count");
  else bad("…and that each match sets its own count", r);
  if (!/\bspots\b/i.test(r) && !/capacity/i.test(r)) ok("…and never claims a capacity or a spot count");
  else bad("the readout must not imply a cap", r);
  // CONTROL: the check would catch the mockup's wording, which said "36 spots".
  if (/\bspots\b/i.test("36 spots — 9 × 9 × 2 teams × 2 pitches")) ok("control: the wording check catches the mockup's phrasing");
  else bad("control: the wording check catches the mockup's phrasing");
  if (/2 pitches/.test(recommendationReadout(18, 2))) ok("two pitches shade the line");
  else bad("two pitches shade the line", recommendationReadout(18, 2));
}

console.log("\nthe create DTO is a whitelist, and blanks never travel");
{
  is("the server's own required set is exactly two", [...SERVER_REQUIRED], ["title", "cityId"]);
  /* AN EXTRA KEY IS A 400 NAMING THE KEY — not an ignored field. Measured: orderPosition, images,
   * cover, phoneNumbers, id, createdAt, deletedAt and isEnabled are each refused with
   * "property X should not exist", which kills the whole create. */
  is("orderPosition is NOT in the create body", CREATE_KEYS.includes("orderPosition" as never), false);
  is("…but IS in the update body", UPDATE_KEYS.includes("orderPosition" as never), true);
  const b = createBody({ title: "X", cityId: "1", abbr: "", address: "  ", description: null,
    lat: "", recommendedPlayerCount: "18", zipcode: "78753", orderPosition: 4, images: [], cover: "x" });
  is("blank strings are omitted, never sent as \"\"", Object.keys(b).sort(), ["cityId", "recommendedPlayerCount", "title", "zipcode"]);
  is("cityId is a number", typeof b.cityId, "number");
  is("recommendedPlayerCount is a number", b.recommendedPlayerCount, 18);
  is("keys outside the DTO cannot leak in", "orderPosition" in b || "images" in b || "cover" in b, false);
  // CONTROL: the builder does carry the keys it should, so the absence above is not vacuous.
  is("control: a full draft produces the full body",
    Object.keys(createBody({ title: "X", cityId: 1, abbr: "A", address: "B", zipcode: "1", description: "d",
      parkingNote: "p", lat: "1.5", lng: "-2.5", recommendedPlayerCount: 18 })).length, 10);
}

console.log("\nthe update body is the DIFF, and clearing is not a change");
{
  const orig = { title: "A", abbr: "AA", cityId: 1, recommendedPlayerCount: 18, description: "d", orderPosition: 7 };
  is("an untouched draft sends nothing", updateBody(orig, { ...orig }), {});
  is("one changed key sends one key", updateBody(orig, { ...orig, abbr: "BB" }), { abbr: "BB" });
  /* CLEARING A BOX IS NOT A CHANGE. The API has no unset for these, and "" would be a 400 or a
   * stored empty string. This is the rule the whole codebase runs on. */
  is("clearing a field sends nothing for it", updateBody(orig, { ...orig, description: "" }), {});
  is("clearing to null sends nothing either", updateBody(orig, { ...orig, description: null }), {});
  is("a numeric change is compared as a number, not a string",
    updateBody(orig, { ...orig, recommendedPlayerCount: "18" }), {});
  is("…and a real numeric change does travel",
    updateBody(orig, { ...orig, recommendedPlayerCount: "22" }), { recommendedPlayerCount: 22 });
  is("orderPosition can be updated", updateBody(orig, { ...orig, orderPosition: 3 }), { orderPosition: 3 });
}

console.log("\nzipcode is a number and we do not invent the leading zero");
{
  is("a plain zip becomes a number", coerceZip("78753"), 78753);
  /* WARSAW. The API column is an integer and 1684 already stores 1452 for the postcode 01-452 —
   * the zero was gone before we saw it. We send digits and show what is stored; re-padding would
   * be inventing a value the API never held. */
  is("01-452 sends as 1452, the value the API already holds", coerceZip("01-452"), 1452);
  is("a blank zip is omitted entirely", coerceZip(""), undefined);
  is("a non-numeric zip is omitted rather than sent as NaN", coerceZip("abc"), undefined);
}

console.log("\nthe form's own required set");
{
  is("an empty draft is missing all five", missingRequired({}).length, 5);
  is("…and names them", missingRequired({}), ["Field name", "City", "Abbreviation", "Address", "Recommended player count"]);
  is("a full draft is missing none",
    missingRequired({ title: "A", cityId: 1, abbr: "A", address: "B", recommendedPlayerCount: 18 }), []);
  is("whitespace does not satisfy a required field",
    missingRequired({ title: "  ", cityId: 1, abbr: "A", address: "B", recommendedPlayerCount: 18 }), ["Field name"]);
}

console.log("\ndelete — Clubhouse refuses what the API allows");
{
  /* PROVEN ON STAGING: a field with a live match on it deletes with a 2xx, vanishes from
   * /admin/fields, and leaves the match pointing at a row nothing renders. The API does not check.
   * ANY match ever, not just future ones — a past match still renders its field on a report. */
  is("a field with matches cannot be deleted", deleteBlock(574).ok, false);
  is("…and the button says the count", deleteBlock(574).reason, "Cannot delete — 574 matches");
  is("one match is singular", deleteBlock(1).reason, "Cannot delete — 1 match");
  is("a field with no matches may be deleted", deleteBlock(0).ok, true);

  // TYPE THE NAME. Not the word DELETE — the thing being destroyed.
  is("the exact name confirms", deleteConfirmed("Onion Creek", "Onion Creek"), true);
  is("a near miss does not", deleteConfirmed("Onion creek", "Onion Creek"), false);
  is("an empty box does not", deleteConfirmed("", "Onion Creek"), false);
  is("…and neither does the word DELETE", deleteConfirmed("DELETE", "Onion Creek"), false);
  is("surrounding whitespace is forgiven", deleteConfirmed("  Onion Creek  ", "Onion Creek"), true);
}

console.log("\nvenue mapping, both directions");
{
  const links = [{ mdapi_field_id: 10, fin_venue_id: 1 }, { mdapi_field_id: 991, fin_venue_id: 5 }];
  const fields = [{ id: 10 }, { id: 1684 }, { id: 397 }];
  is("a linked field is mapped", isMapped(10, links), true);
  is("an unlinked one is not", isMapped(1684, links), false);
  const s = unmappedSummary(fields, links, new Set([1684]));
  /* BOTH NUMBERS. "No venue mapping" and "running matches this month" are different questions;
   * production is 3 and 1. The mockup showed the second and labelled it the first. */
  is("the unmapped list is every unlinked field", s.unmapped, [1684, 397]);
  is("…and the running subset is the ones with matches this month", s.running, [1684]);
  /* THE ORPHAN THE OTHER WAY — our link points at a field the API no longer lists. That is the
   * SOFT delete made visible; production has three (991, 1222, 793). */
  is("a link to a vanished field is an orphan", orphanLinks(links, new Set([10])), [{ fieldId: 991, venueId: 5 }]);
  is("control: a link to a live field is not", orphanLinks(links, new Set([10, 991])), []);
}

console.log("\nphone numbers — and what never reaches change_log");
{
  is("a plain number is valid", validPhone("+1 512 555 0147"), true);
  is("an empty box is not", validPhone(""), false);
  is("a stray word is not", validPhone("call the office"), false);
  /* THE AUDIT LINE NAMES THE ACT, NOT THE NUMBER. change_log has different access rules from this
   * endpoint; a number in it would make the audit trail a second copy of contact details. */
  const note = phoneAuditNote("added", 1585);
  is("the audit note says what happened and to which field", note, "phone number added on field 1585");
  if (!/\d{7,}/.test(note)) ok("…and carries no phone number");
  else bad("the audit note carries a phone number", note);
  // CONTROL: the check would catch a number if one were there.
  if (/\d{7,}/.test("phone number +15125550147 added")) ok("control: the check finds a number when there is one");
  else bad("control: the check finds a number when there is one");
}

console.log("\nthe wiring");
{
  const model = readFileSync("src/lib/fieldsModel.ts", "utf8");
  const route = readFileSync("src/app/api/fields/route.ts", "utf8");
  const phones = readFileSync("src/app/api/fields/phones/route.ts", "utf8");
  const view = readFileSync("src/components/FieldsView.tsx", "utf8");
  // POSITIVE CONTROLS: the files were actually read.
  if (/FORMATS/.test(model) && /DELETE_ENABLED/.test(route) && /fv-drawer/.test(view)) ok("control: all four files were read");
  else bad("control: all four files were read");

  // Comments are stripped before any "must not contain" check — a grep that reads prose as code
  // goes red for being well documented, and the fix people reach for is deleting the comment.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const routeCode = strip(route), phonesCode = strip(phones);
  is("control: the stripper removes a comment", strip("/* PUT */ const a=1;").trim(), "const a=1;");
  is("control: …and leaves code", strip("const a = 'PUT';").trim(), "const a = 'PUT';");

  if (/"PUT"/.test(routeCode) && !/"PATCH"/.test(routeCode)) ok("the update uses PUT — PATCH is a 404 on this resource");
  else bad("the update uses PUT, not PATCH");
  if (/DELETE_ENABLED = false/.test(route)) ok("delete is bolted off for production");
  else bad("delete is bolted off for production", "IT WOULD REACH PRODUCTION");
  if (/recordWrite\(/.test(routeCode)) ok("the field writes go through recordWrite");
  else bad("the field writes go through recordWrite");
  if (/recordWrite\(/.test(phonesCode)) ok("the phone writes go through recordWrite");
  else bad("the phone writes go through recordWrite");
  /* NO PHONE NUMBER IN THE LOG BODY. The recordWrite ctx must carry the action, not the number. */
  if (/body: \{ fieldId, action: "phone (added|removed)" \}/.test(phonesCode)) ok("the phone audit body is the action, never the number");
  else bad("the phone audit body is the action, never the number", "PII WOULD REACH change_log");
  if (!/body: \{ phoneNumber/.test(phonesCode)) ok("…and no phone number is passed as a log body");
  else bad("a phone number is passed as a log body");
  if (/readBack\(/.test(routeCode)) ok("every write reads back from the list — there is no single-field GET");
  else bad("every write reads back", "a 2xx would be the verdict");
  if (/verdict/.test(routeCode)) ok("the response carries a verdict, not just a status");
  else bad("the response carries a verdict");
}

console.log("\nphotos are read-only and the page says so");
{
  const view = readFileSync("src/components/FieldsView.tsx", "utf8");
  if (/PHOTOS_READ_ONLY_NOTE/.test(view)) ok("the photos panel states that uploads are unavailable");
  else bad("the photos panel states that uploads are unavailable");
  if (!/Add photo/.test(view)) ok("…and offers no upload control that would do nothing");
  else bad("an upload control is present", "SHIPPING A CONTROL THAT LOOKS LIVE AND IS NOT");
  /* THE ONE TARGETED READ, recorded: every images[].url and cover on production — 79 of them —
   * is on a raw S3 bucket, not the API host. That is the shape of a presigned direct upload and
   * explains why no /admin upload route exists. Reported, not acted on. */
  is("the image host is recorded as the S3 bucket", IMAGE_HOST, "playmatchday.s3.us-west-1.amazonaws.com");
  if (!/amazonaws/.test(IMAGE_HOST.replace("playmatchday.s3.us-west-1.amazonaws.com", "")) ) ok("control: the constant is the host and nothing else");
  else bad("control: the constant is the host and nothing else");
}

console.log(`\nfields-model: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
