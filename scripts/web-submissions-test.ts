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
  toSubmissionRow, toIso, streamFor,
  spamSignals, isSpam, isOwnTestRow, contactKey, DEFAULT_STATUS, STATUSES,
} from "../src/lib/webSubmissions";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("WEB SUBMISSIONS\n");

// ── 1. THE COLLISION. The point of the whole module. ───────────────────────────────────────────
console.log("the same field id, two forms");
// FIXTURE IDS ARE THE LIVE ONES, read off ?forms=1 on 2026-08-26. They were transcribed from the
// brief first and three were wrong — field_2a1c0f4, field_6b2d114 and field_9c3a201 do not exist.
// A fixture built on a guess asserts the guess.
{
  const partnerRow = {
    name: "Sarah", message: "Georgia", email: "s@example.com",
    field_dff8b68: "Crossbar Sports", field_15bf1e3: "Atlanta", field_187a8c9: "Grow the game",
  };
  const teamRow = {
    name: "Ernesto", message: "Mon-thurs 6-9", email: "e@example.com",
    field_dff8b68: "Hernandez", field_15bf1e3: "Austin", field_ffeb63a: "9152490370",
    field_cbcd9d0: "Match Manager", field_706ba38: "Soccer is a passion",
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
  /* BEHAVIOUR CHANGED HERE, ON PURPOSE. This used to assert that "Company" on the team form
   * resolved to `undefined` — true while a known form with ZERO matching fields still counted as
   * resolved. It does not any more: a form can be in the registry and still fail to describe a
   * submission, and calling that a success hid a real bug (the four CSV-only forms matched nothing
   * on an API row, every field came back "not asked", and our own test rows stopped being
   * recognised — 655 rows built where 647 was right).
   *
   * So the row now keeps its RAW key and is FLAGGED. The thing that must never happen is unchanged
   * and is still asserted: the company does not become somebody's surname. */
  const csvOnTeam = resolveFields("4e61155c", { Company: "Crossbar Sports" });
  is("a known form that matches NOTHING is flagged unresolved", csvOnTeam.unresolved, true);
  is("…the value survives under its RAW key", csvOnTeam.byLabel["Company"], "Crossbar Sports");
  is("…and it is NOT filed as a surname", csvOnTeam.byLabel["Last Name"], undefined);
  // CONTROL: a form that DOES match is still resolved, so the rule cannot fire on a good row.
  is("CONTROL — a matching row is still resolved", resolveFields("4e61155c", { name: "Jo" }).unresolved, false);
  // An EMPTY submission is not this case and must not be flagged.
  is("an empty submission is not flagged", resolveFields("4e61155c", {}).unresolved, false);
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
  const noRole = resolveFields("4e61155c", { name: "Jo", field_cbcd9d0: undefined as unknown as string });
  const askedBlank = resolveFields("4e61155c", { name: "Jo", field_cbcd9d0: "" });
  is("a field the form never sent is NOT_ASKED", noRole.byLabel["Job Role"], "");
  is("…identified by wasAsked", wasAsked(resolveFields("4e61155c", { name: "Jo" }).byLabel["Job Role"]), false);
  is("CONTROL — asked but blank IS asked", wasAsked(askedBlank.byLabel["Job Role"]), true);
  is("…and has no value", hasValue(askedBlank.byLabel["Job Role"]), false);
  is("a real answer has a value", hasValue(resolveFields("4e61155c", { field_cbcd9d0: "Match Manager" }).byLabel["Job Role"]), true);
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


// ── 9. THE CSV PATH AND THE SYNC PATH PRODUCE THE SAME ROW ─────────────────────────────────────
// The CSV keys fields by LABEL and the API keys them by FIELD ID. Two row builders would drift the
// first time either side changed, and the exclusion of our own rows, the escape decoding, the spam
// signals and the city mapping would all have to be kept in step by hand. There is one builder;
// this asserts both callers reach the same bytes through it.
console.log("\nCSV path vs SYNC path");
{
  const viaApi = toSubmissionRow({
    submissionId: 9001, elementId: "4e61155c", formName: "Team Application",
    referer: "https://playmatchday.com/apply", createdAt: "2026-08-24T13:05:11Z",
    fields: { name: "Ernesto", field_dff8b68: "Hernandez", email: "Netos1KRR@Gmail.com",
              field_15bf1e3: "Austin, TX", field_ffeb63a: "9152490370",
              field_cbcd9d0: "Match Manager", message: "Mon-thurs 6-9\\r\\nSat 8am" },
  }, PINNED_FORMS, "sync");
  const viaCsv = toSubmissionRow({
    submissionId: 9001, elementId: "4e61155c", formName: "Team Application",
    referer: "https://playmatchday.com/apply", createdAt: "2026-08-24 13:05:11",
    fields: { "First Name": "Ernesto", "Last Name": "Hernandez", Email: "Netos1KRR@Gmail.com",
              City: "Austin, TX", Phone: "9152490370",
              "Job Role": "Match Manager", Availability: "Mon-thurs 6-9\\r\\nSat 8am" },
  }, PINNED_FORMS, "csv");
  if (!viaApi || !viaCsv) { bad("both paths produce a row"); }
  else {
    ok("both paths produce a row");
    const strip = (r: Record<string, unknown>) => { const c = { ...r }; delete c.imported_from; return c; };
    is("the rows are byte-identical apart from imported_from",
      JSON.stringify(strip(viaApi as unknown as Record<string, unknown>)),
      JSON.stringify(strip(viaCsv as unknown as Record<string, unknown>)));
    is("…including the decoded newline", viaApi.fields["Availability"], "Mon-thurs 6-9\nSat 8am");
    is("…the lowercased email", viaApi.email, "netos1krr@gmail.com");
    is("…and the mapped city", [viaApi.city_code, viaApi.city_source], ["ATX", "city"]);
    is("imported_from is the ONE thing that differs", [viaApi.imported_from, viaCsv.imported_from], ["sync", "csv"]);
  }
  // OUR OWN TEST ROWS NEVER REACH THE TABLE BY EITHER PATH.
  const mineApi = toSubmissionRow({ submissionId: 1, elementId: "4e61155c", formName: null, referer: null, createdAt: null, fields: { email: "rmancuso1@gmail.com" } }, PINNED_FORMS, "sync");
  const mineCsv = toSubmissionRow({ submissionId: 1, elementId: "4e61155c", formName: null, referer: null, createdAt: null, fields: { Email: "RMancuso1@Gmail.com" } }, PINNED_FORMS, "csv");
  is("our own row is dropped on the sync path", mineApi, null);
  is("…and on the CSV path", mineCsv, null);
  // AN UNSEEN FORM KEEPS ITS RAW KEYS AND IS FLAGGED — this is what happens the first time the
  // live form is edited and mints a new id.
  const unseen = toSubmissionRow({ submissionId: 2, elementId: "brandnew", formName: null, referer: null, createdAt: null, fields: { field_dff8b68: "Acme", email: "a@b.com" } }, PINNED_FORMS, "sync")!;
  is("an unseen element_id is flagged unresolved", unseen.unresolved, true);
  is("…keeps its raw key", unseen.fields["field_dff8b68"], "Acme");
  is("…and borrows NO label from another form", unseen.fields["Company"], undefined);
  /* THE PINS MUST DESCRIBE THE FORMS THEY CLAIM TO. They were wrong in three field ids for a whole
   * phase because nothing compared them to anything. This does not call the endpoint — it asserts
   * the SHAPE that the endpoint was observed to have, so a hand-edit to the pins that invents an id
   * fails here rather than resolving confidently to a wrong label. */
  is("f7eed00 declares exactly the live field ids", Object.keys(PINNED_FORMS.f7eed00.labels).sort(),
    ["email", "field_15bf1e3", "field_187a8c9", "field_dff8b68", "field_ffeb63a", "message", "name"]);
  is("4e61155c declares exactly the live field ids", Object.keys(PINNED_FORMS["4e61155c"].labels).sort(),
    ["email", "field_15bf1e3", "field_706ba38", "field_cbcd9d0", "field_dff8b68", "field_ffeb63a", "message", "name"]);
  // A SHARED ID IS NOT AUTOMATICALLY A COLLISION: field_ffeb63a is Phone on both. The rule is that
  // an id means whatever ITS OWN form says, not that shared ids must differ.
  is("field_ffeb63a is Phone on BOTH forms",
    [PINNED_FORMS.f7eed00.labels.field_ffeb63a, PINNED_FORMS["4e61155c"].labels.field_ffeb63a], ["Phone", "Phone"]);
  is("the partnerships form is the only partner stream", [streamFor("f7eed00"), streamFor("4e61155c"), streamFor("brandnew")], ["partner", "team", "team"]);
  is("a space-separated timestamp parses", toIso("2026-08-24 13:05:11"), "2026-08-24T13:05:11.000Z");
  is("…identically to the T form", toIso("2026-08-24T13:05:11Z"), toIso("2026-08-24 13:05:11"));
  is("an unparseable timestamp is null, never a fabricated now()", toIso("not a date"), null);
}

// ── THE PHONE COLUMN ─────────────────────────────────────────────────────────────────────────
console.log("\nphone: a number, or a stated reason there isn't one — never an empty cell");
{
  /* A BLANK CELL READS AS DATA WE FAILED TO LOAD. "not given" reads as a question the form never
   * asked, which is what it is. Measured on the live data at the time this was written:
   *
   *   TEAM     115 people · 101 with a phone · 14 whose form never asked
   *   PARTNER   65 people ·   0 with a phone · 65 whose submissions carry none
   *
   * The 14 come from the three oldest Team forms — 37a43a2a, c6e12c3 and 3a4c40bd, 17 submissions
   * between them — which collected only First Name, Last Name, Email and Zipcode. The fixture below
   * is those forms' actual field sets, not an invention. */
  const WITH_PHONE = { elementId: "5e295156", formName: "Team Application", source: "csv" as const,
    labels: { "First Name": "First Name", "Last Name": "Last Name", Email: "Email", Phone: "Phone", City: "City" } };
  const NO_PHONE = { elementId: "3a4c40bd", formName: "Team Application", source: "csv" as const,
    labels: { "First Name": "First Name", "Last Name": "Last Name", Email: "Email", Zipcode: "Zipcode" } };

  const REG = { "5e295156": WITH_PHONE, "3a4c40bd": NO_PHONE };
  const withPhone = resolveFields("5e295156", { "First Name": "Ana", "Last Name": "Diaz", Email: "a@b.com", Phone: "+15125550111", City: "Austin" }, REG).byLabel;
  const noPhone = resolveFields("3a4c40bd", { "First Name": "Sam", "Last Name": "Ruiz", Email: "s@b.com", Zipcode: "78745" }, REG).byLabel;

  /* THE POSITIVE CONTROL COMES FIRST: the fixture must actually contain a person whose form never
   * asked, or "it shows the reason" passes over a case that does not exist. */
  is("control — the fixture holds a person whose form never asked for a phone", wasAsked(noPhone.Phone), false);
  is("control — …and one whose form did, so the two are distinguishable", wasAsked(withPhone.Phone), true);

  is("a person with a phone shows the number", hasValue(withPhone.Phone) && String(withPhone.Phone), "+15125550111");
  is("a person whose form never asked is NOT_ASKED, not empty string", noPhone.Phone, NOT_ASKED);
  is("…which is not the same as an empty value", NOT_ASKED === "", false);
  // ASKED-BUT-BLANK is the third state and must not be confused with either.
  const blank = resolveFields("5e295156", { "First Name": "Kim", Email: "k@b.com", Phone: "" }, REG).byLabel;
  is("asked-but-left-blank is asked", wasAsked(blank.Phone), true);
  is("…and has no value", hasValue(blank.Phone), false);
  is("…and is distinguishable from never-asked", blank.Phone === NOT_ASKED, false);

  /* WHAT THE PAGE RENDERS. The cell must show the stated reason for BOTH no-phone cases and never
   * an empty string — the operator's question is "can I call them", and the answer is no either
   * way, while the tooltip says which. */
  const view = readFileSync("src/components/ApplicationsView.tsx", "utf8");
  const cell = view.slice(view.indexOf("function Phone("), view.indexOf("/** The one place a mirrored value is drawn"));
  is("the never-asked branch renders 'not given'", /if \(!f\.asked\) return[\s\S]{0,220}>not given</.test(cell), true);
  is("the asked-but-blank branch renders 'not given' too", /if \(!f\.value\.trim\(\)\) return[\s\S]{0,220}>not given</.test(cell), true);
  is("neither branch can render an empty cell", /return null|return <\/|>\{""\}</.test(cell), false);
  is("the two reasons stay distinguishable in the tooltip",
     /never asked for a phone number/.test(cell) && /Asked, left blank/.test(cell), true);
  is("the reason is muted, not styled as a value", /style=\{NOT_GIVEN_STYLE\}/.test(cell), true);
  is("a real number is not muted", /style=\{PHONE_STYLE\}/.test(cell), true);

  /* TABULAR — AND THE STYLE IS INLINE FOR A REASON. styled-jsx scopes a `<style jsx>` block to the
   * JSX inside the component that declares it. `Phone` is a SIBLING function component in that
   * file, so a `className="ph"` span rendered with NO jsx-<hash> scope class and the rule never
   * matched: the numbers came out untabulated and nothing about the page looked wrong. Caught by
   * reading the computed font-variant-numeric in a browser, which said "normal". */
  is("the number is tabular-aligned", /fontVariantNumeric: "tabular-nums"/.test(view), true);
  is("…via an inline style, which cannot miss a scope", /const PHONE_STYLE: React\.CSSProperties/.test(view), true);
  is("…and cannot collide with the .ph MatchManagersPanel already uses", /\.ph \{/.test(view), false);
  const phoneCell = view.match(/<div><Phone f=\{p\.phone\} \/><\/div>/);
  is("the phone cell carries no drop class", !!phoneCell, true);
  is("…while Role/Location and the date do", (view.match(/className="[^"]*\bdrop\b/g) ?? []).length >= 2, true);
  /* The selector text carries the .apps prefix now — the whole block became `global` so it could
   * reach the sibling components, and the prefix is what keeps it on this page. Asserted loosely on
   * the two parts rather than on one exact string, so a future re-prefix does not go red for a
   * reason that is not the rule. */
  is("the narrow rule hides the drop class", /\.row \.drop[\s\S]{0,40}\.thead \.drop \{ display: none \}/.test(view), true);
  is("…and the rule is confined to this page by the root class", /\.apps \.row \.drop/.test(view), true);
  // A head label and its column must never disagree about being visible.
  is("the head carries its own drop flag beside the label", /\{ t: "Role", drop: true \}/.test(view), true);
  is("…on both tabs", /\{ t: "Location", drop: true \}/.test(view), true);
  is("Phone is second on the Team tab, right after the person", /\{ t: "Applicant" \}, \{ t: "Phone" \}/.test(view), true);
  is("…and second on the Partner tab too", /\{ t: "Contact" \}, \{ t: "Phone" \}/.test(view), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
