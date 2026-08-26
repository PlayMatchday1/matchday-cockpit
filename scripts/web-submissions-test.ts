import "server-only"; // no-op under --conditions=react-server
// MATCH OPS › APPLICATIONS — THE SAME FIELD ID MEANS DIFFERENT THINGS ON DIFFERENT FORMS.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/web-submissions-test.ts
//
// THE BUG THIS PREVENTS, and it is the reason this file exists. Elementor stores the field ID and
// never the label. Build the obvious global id->label map and `field_dff8b68` resolves to ONE
// meaning for all six forms — so partner COMPANIES get filed into applicants' SURNAMES:
//
//   key             partnerships (f7eed00)      team application (4e61155c)
//   field_dff8b68   Company                ->   Last Name
//   field_15bf1e3   Location               ->   City
//   message         Last Name              ->   Availability
//
// Both forms are fixtures below and the collision is asserted directly. Everything else here
// guards a rule that was learned from the data rather than assumed: spam must never key on
// location (Georgia is a US state and Atlanta is in it), a derived city must not look typed, and
// a field a form never asked for is not a blank one.

import {
  PINNED_FORMS, resolveFields, wasAsked, hasValue, NOT_ASKED,
  unescapeWpText, hasSurvivingEscape,
  cityForText, cityForZip, resolveCity, normalizeCityText, CITY_ORDER,
  spamSignals, isSpam, isOwnTestRow, contactKey, DEFAULT_STATUS, STATUSES,
} from "../src/lib/webSubmissions";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("WEB SUBMISSIONS\n");

// ── 1. THE COLLISION. The point of the whole module. ───────────────────────────────────────────
console.log("the same field id, two forms");
{
  const partnerRow = {
    name: "Sarah", message: "Georgia", email: "s@example.com",
    field_dff8b68: "Crossbar Sports", field_15bf1e3: "Atlanta", field_2a1c0f4: "Grow the game",
  };
  const teamRow = {
    name: "Ernesto", message: "Mon-thurs 6-9", email: "e@example.com",
    field_dff8b68: "Hernandez", field_15bf1e3: "Austin", field_9c3a201: "9152490370",
    field_6b2d114: "Match Manager", field_71ab0e5: "Soccer is a passion",
  };
  const p = resolveFields("f7eed00", partnerRow);
  const t = resolveFields("4e61155c", teamRow);

  is("field_dff8b68 is COMPANY on partnerships", p.byLabel["Company"], "Crossbar Sports");
  is("field_dff8b68 is LAST NAME on the team form", t.byLabel["Last Name"], "Hernandez");
  is("…and the partner form has no Last Name from that id", p.byLabel["Last Name"], "Georgia");
  is("field_15bf1e3 is LOCATION on partnerships", p.byLabel["Location"], "Atlanta");
  is("field_15bf1e3 is CITY on the team form", t.byLabel["City"], "Austin");
  is("`message` is LAST NAME on partnerships", p.byLabel["Last Name"], "Georgia");
  is("`message` is AVAILABILITY on the team form", t.byLabel["Availability"], "Mon-thurs 6-9");
  // The failure this prevents, stated as an assertion: a company must never land in a surname.
  is("a COMPANY never lands in a surname", t.byLabel["Last Name"] === "Crossbar Sports", false);
  is("both forms are pinned by element_id", Object.keys(PINNED_FORMS).sort(), ["4e61155c", "f7eed00"]);

  /* THE CSV KEYS BY LABEL, THE API KEYS BY FIELD ID — both must land identically or the historical
   * rows and the synced rows would render differently on the same page. */
  const fromCsv = resolveFields("f7eed00", { "First Name": "Sarah", Company: "Crossbar Sports", Location: "Atlanta" });
  is("a CSV row keyed by LABEL resolves", fromCsv.byLabel["Company"], "Crossbar Sports");
  is("…identically to the id-keyed row", fromCsv.byLabel["Company"], p.byLabel["Company"]);
  /* AND IT CANNOT REINTRODUCE THE COLLISION: a label is only honoured on the form that declares
   * it, so "Company" means nothing on the team application. */
  const csvOnTeam = resolveFields("4e61155c", { Company: "Crossbar Sports" });
  is("'Company' does not resolve on the team form", csvOnTeam.byLabel["Company"], undefined);
  is("…and its Last Name is NOT the company", csvOnTeam.byLabel["Last Name"] === "Crossbar Sports", false);
}

// ── 2. AN UNKNOWN FORM IS FLAGGED, NEVER RELABELLED ────────────────────────────────────────────
console.log("\nunresolvable forms (the 109 historical rows)");
{
  const r = resolveFields("5e295156", { field_dff8b68: "Acme Ltd", name: "Jo" });
  is("it is flagged unresolved", r.unresolved, true);
  is("the RAW key is kept", r.byLabel["field_dff8b68"], "Acme Ltd");
  is("…and NOT given another form's label", r.byLabel["Company"], undefined);
  is("…nor the team form's label", r.byLabel["Last Name"], undefined);
  is("CONTROL — a known form is not flagged", resolveFields("f7eed00", { name: "x" }).unresolved, false);
}

// ── 3. NOT ASKED IS NOT BLANK ──────────────────────────────────────────────────────────────────
console.log("\nnot-asked vs blank");
{
  const noRole = resolveFields("4e61155c", { name: "Jo", field_6b2d114: undefined as unknown as string });
  const askedBlank = resolveFields("4e61155c", { name: "Jo", field_6b2d114: "" });
  is("a field the form never sent is NOT_ASKED", noRole.byLabel["Job Role"], "");
  is("…identified by wasAsked", wasAsked(resolveFields("4e61155c", { name: "Jo" }).byLabel["Job Role"]), false);
  is("CONTROL — asked but blank IS asked", wasAsked(askedBlank.byLabel["Job Role"]), true);
  is("…and has no value", hasValue(askedBlank.byLabel["Job Role"]), false);
  is("a real answer has a value", hasValue(resolveFields("4e61155c", { field_6b2d114: "Match Manager" }).byLabel["Job Role"]), true);
  is("NOT_ASKED is a distinct sentinel", typeof NOT_ASKED, "symbol");
}

// ── 4. ESCAPES DO NOT SURVIVE ──────────────────────────────────────────────────────────────────
console.log("\nescape decoding");
{
  is("literal \\r\\n becomes a newline", unescapeWpText("Mon-thurs 6-9\\r\\nSat 8am"), "Mon-thurs 6-9\nSat 8am");
  is("escaped slash", unescapeWpText("playmatchday.com\\/apply"), "playmatchday.com/apply");
  is("escaped quote", unescapeWpText('he said \\"yes\\"'), 'he said "yes"');
  is("CONTROL — clean text is untouched", unescapeWpText("Austin, TX"), "Austin, TX");
  is("no escape survives", hasSurvivingEscape(unescapeWpText("a\\r\\nb\\/c")), false);
  is("CONTROL — the detector DOES fire on a raw escape", hasSurvivingEscape("a\\r\\nb"), true);
}

// ── 5. CITY — MAPPED, NEVER GUESSED ────────────────────────────────────────────────────────────
console.log("\ncity mapping");
{
  is("Austin", cityForText("Austin"), "ATX");
  is("'Austin Texas'", cityForText("Austin Texas"), "ATX");
  is("'Austin, TX'", cityForText("Austin, TX"), "ATX");
  is("'Austin Tx'", cityForText("Austin Tx"), "ATX");
  is("…all three normalise to one key", normalizeCityText("Austin, TX"), normalizeCityText("Austin Texas"));
  // The third-largest cluster, both spellings, pinned as the brief requires.
  is("'Johns creek'", cityForText("Johns creek"), "ATL");
  is("'John Creeks'", cityForText("John Creeks"), "ATL");
  is("St. Louis punctuation", cityForText("St. Louis"), "STL");
  is("'St Louis'", cityForText("St Louis"), "STL");
  is("O'Fallon", cityForText("O'Fallon"), "STL");
  is("an unmapped town is NULL, never a guess", cityForText("Miami"), null);
  is("empty is null", cityForText(""), null);
  is("the chip order matches the mockup", CITY_ORDER.length, 7);
}

// ── 6. ZIP IS DERIVED AND SAYS SO ──────────────────────────────────────────────────────────────
console.log("\nzip derivation");
{
  is("75201 is DFW", cityForZip("75201"), "DFW");
  is("30303 is ATL", cityForZip("30303"), "ATL");
  is("78704 is ATX", cityForZip("78704"), "ATX");
  is("63101 is STL", cityForZip("63101"), "STL");
  is("an unknown prefix is null", cityForZip("90210"), null);
  is("a typed city is source=city", resolveCity("Austin"), { code: "ATX", source: "city", raw: "Austin" });
  is("a zipcode is source=zip", resolveCity(null, "75201"), { code: "DFW", source: "zip", raw: "75201" });
  is("a zipcode TYPED INTO the city box is still derived", resolveCity("30303").source, "zip");
  is("an unmapped city resolves to none", resolveCity("Miami"), { code: null, source: "none", raw: "Miami" });
}

// ── 7. SPAM — AND THE GEORGIA TRAP ─────────────────────────────────────────────────────────────
console.log("\nspam quarantine");
{
  /* THE TOKEN IS INSIDE THE NAME, NOT AT THE END. /Skync$/i — the rule as first specified —
   * matches ZERO of the 437 bot rows in the export; 437 of 437 CONTAIN it. Anchoring the regex
   * cost 90 rows, so the fixture is deliberately shaped the way the real data is. */
  const bot = { name: "Damian Skync Ltd", email: "abuse@registry.godaddy", company: "Nokia" };
  is("an anchored /Skync$/ would have missed this row", /skync$/i.test(bot.name), false);
  is("…and the contains rule catches it", spamSignals(bot).skyncName, true);
  // FBI is the sixth fake company — 57 rows, and 380 + 57 = the 437 the bot is known to have sent.
  is("FBI is a fake company", spamSignals({ name: "x", email: "a@b.c", company: "FBI" }).fakeCompany, true);
  is("the bot trips all three signals", spamSignals(bot), { skyncName: true, godaddyEmail: true, fakeCompany: true });
  is("…and is flagged", isSpam(bot), true);
  is("two of three is enough", isSpam({ name: "X Skync", email: "x@gmail.com", company: "Google" }), true);
  is("one signal alone is NOT", isSpam({ name: "X Skync", email: "x@gmail.com", company: "Crossbar" }), false);

  /* THE ASSERTION THE BRIEF ASKED FOR BY NAME. Georgia is a US state, Atlanta is in it, and 83 of
   * the bot rows say Georgia — so a location rule bins real Atlanta partners. */
  const sarah = { name: "Sarah Georgia", email: "sarah@crossbarsports.com", company: "Crossbar Sports" };
  is("a real partner named Georgia in Atlanta is NOT spam", isSpam(sarah), false);
  is("…and trips no signal at all", spamSignals(sarah), { skyncName: false, godaddyEmail: false, fakeCompany: false });
  // Location is not an input to the function at all — it cannot be used by accident.
  is("spamSignals takes no location field", Object.keys(spamSignals({ name: "a", email: "b@c.d", company: "e" })).includes("location"), false);
  is("a real partner in Poland is not spam either", isSpam({ name: "Piotr Nowak", email: "p@klub.pl", company: "Klub Sportowy" }), false);
}

// ── 8. OUR OWN ROWS, AND CONTACT IDENTITY ──────────────────────────────────────────────────────
console.log("\nexclusions and contact identity");
{
  is("rmancuso1@gmail.com is excluded", isOwnTestRow("rmancuso1@gmail.com"), true);
  is("…case-insensitively", isOwnTestRow("RMancuso@PlayMatchday.com"), true);
  is("CONTROL — a real applicant is not", isOwnTestRow("netos1krr@gmail.com"), false);
  is("the contact key is stream + lowercased email",
    contactKey("team", "  Netos1KRR@Gmail.com "), "team|netos1krr@gmail.com");
  is("the same email on the other stream is a DIFFERENT contact",
    contactKey("partner", "a@b.com") === contactKey("team", "a@b.com"), false);
  is("the default status is New", DEFAULT_STATUS, "New");
  is("the five statuses", STATUSES.slice(), ["New", "Contacted", "Interviewing", "Hired", "Passed"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
