// ONE-OFF: import the Elementor CSV export into web_submissions / web_contacts / web_form_labels.
//   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local \
//     scripts/import-web-submissions.ts <dir-of-csvs> [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it parses, counts and reports and writes nothing, because
// the counts are the acceptance criterion: 172 team rows -> 160 after excluding our own -> 115
// distinct people; 492 partner -> 437 spam -> 43 distinct. If those do not match, nothing should
// be written and the run should say so rather than leaving a half-imported table behind.
//
// THE FOUR UNRECOVERABLE FORMS. Only f7eed00 and 4e61155c still resolve from ?forms=1. The other
// four were edited or replaced and their labels exist ONLY here — 109 submissions. That is why the
// CSV is the first import and not a convenience.

import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  resolveCity, isSpam, isOwnTestRow, unescapeWpText, hasSurvivingEscape,
  PINNED_FORMS, toSubmissionRow, type Stream, type FormLabels,
} from "../src/lib/webSubmissions";

const dir = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!dir) { console.log("usage: import-web-submissions.ts <dir> [--apply]"); process.exit(1); }

/** Minimal RFC4180 reader — the export has quoted fields containing commas AND newlines. */
function parseCsv(textRaw: string): string[][] {
  let text = textRaw;
  /* STRIP THE BOM. The export is UTF-8 WITH a byte-order mark, so the first header arrives as
   * "\ufeffFirst Name" and rec["First Name"] is undefined for EVERY row in EVERY file. It cost
   * the spam rule its strongest signal — the bot's token lives in First Name, so with that column
   * unreadable the count came out 396 instead of 437 and looked like a rule problem rather than a
   * parsing one. Python's csv reader hides this behind encoding="utf-8-sig"; nothing here does. */
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

const META = new Set(["Form Name (ID)", "Submission ID", "Created At", "User ID", "User Agent", "User IP", "Referrer"]);

type Parsed = {
  submissionId: number; elementId: string; formName: string; createdAt: string;
  referer: string; stream: Stream; fields: Record<string, string>; email: string;
};

const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
const parsed: Parsed[] = [];
const labelRows: { element_id: string; field_id: string; label: string; form_name: string; source: "csv" }[] = [];
const perForm = new Map<string, number>();

for (const f of files) {
  const el = /\(([0-9a-f]+)\)/.exec(f)?.[1];
  if (!el) { console.log(`SKIP (no element id in name): ${f}`); continue; }
  const rows = parseCsv(readFileSync(`${dir}/${f}`, "utf8"));
  const hdr = rows[0];
  const formName = f.includes("partnerships") ? "Form partnerships" : "Team Application";
  const stream: Stream = el === "f7eed00" ? "partner" : "team";

  /* THE LABEL REGISTRY. For a CSV form the column header IS the label and there is no field id, so
   * the id is the label. resolveFields accepts either key, and a label is only honoured on the form
   * that declares it — which is what stops this reintroducing the id collision. */
  for (const h of hdr) if (!META.has(h)) labelRows.push({ element_id: el, field_id: h, label: h, form_name: formName, source: "csv" });

  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    hdr.forEach((h, i) => { rec[h] = r[i] ?? ""; });
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (META.has(k)) continue;
      const clean = unescapeWpText(v);
      if (hasSurvivingEscape(clean)) throw new Error(`escape survived unescape on submission ${rec["Submission ID"]} field ${k}`);
      fields[k] = clean;
    }
    parsed.push({
      submissionId: Number(rec["Submission ID"]),
      elementId: el, formName, createdAt: rec["Created At"] ?? "",
      referer: rec["Referrer"] ?? "", stream, fields,
      email: String(fields["Email"] ?? "").trim().toLowerCase(),
    });
  }
  perForm.set(el, (perForm.get(el) ?? 0) + rows.length - 1);
}

console.log("=== FORMS ===");
for (const [el, n] of [...perForm].sort((a, b) => b[1] - a[1])) {
  const known = el in PINNED_FORMS;
  console.log(`  ${el.padEnd(10)} ${String(n).padStart(4)} rows   labels: ${known ? "forms-api + csv" : "CSV ONLY (not recoverable from the site)"}`);
}
console.log(`  TOTAL ${parsed.length} rows\n`);

// ── THE COUNT LADDER, printed at every stage ─────────────────────────────────────────────────
const ladder = (stream: Stream) => {
  const raw = parsed.filter((p) => p.stream === stream);
  const mine = raw.filter((p) => isOwnTestRow(p.email));
  const notMine = raw.filter((p) => !isOwnTestRow(p.email));
  const spam = notMine.filter((p) => p.stream === "partner" && isSpam({
    name: `${p.fields["First Name"] ?? ""} ${p.fields["Last Name"] ?? ""}`,
    email: p.email, company: p.fields["Company"] ?? "",
  }));
  const clean = notMine.filter((p) => !spam.includes(p));
  const people = new Set(clean.filter((p) => p.email).map((p) => p.email));
  return { raw: raw.length, mine: mine.length, notMine: notMine.length, spam: spam.length, clean: clean.length, people: people.size };
};
const team = ladder("team"), partner = ladder("partner");
console.log("=== COUNT LADDER ===");
console.log(`  TEAM     raw ${team.raw}  -> minus ours ${team.mine} = ${team.notMine}  -> distinct people ${team.people}`);
console.log(`  PARTNER  raw ${partner.raw}  -> minus ours ${partner.mine} = ${partner.notMine}  -> minus spam ${partner.spam} = ${partner.clean}  -> distinct people ${partner.people}`);

/* 41, NOT THE 43 THE BRIEF STATED — and the difference is entirely deliberate.
 *
 * The brief's TEAM ladder has a "minus mine" step; its PARTNER ladder does not, so 43 counts
 * Ryan's own test enquiries as two people. Five partner rows are his, under two addresses, with
 * companies 'test', 'test', 'test', 'Applebees' and 'Bob Vance Refrigeration'.
 *
 * Ryan's call, 2026-08-26: exclude them everywhere and take 41. One exclusion rule for both
 * streams, and 'Applebees' does not sit on a partner-leads page forever. */
const EXPECT = { teamRaw: 172, teamNotMine: 160, teamPeople: 115, partnerRaw: 492, partnerSpam: 437, partnerPeople: 41 };
const checks: [string, number, number][] = [
  ["team raw", team.raw, EXPECT.teamRaw],
  ["team after excluding ours", team.notMine, EXPECT.teamNotMine],
  ["team distinct people", team.people, EXPECT.teamPeople],
  ["partner raw", partner.raw, EXPECT.partnerRaw],
  ["partner spam", partner.spam, EXPECT.partnerSpam],
  ["partner distinct people", partner.people, EXPECT.partnerPeople],
];
let bad = 0;
console.log("\n=== ACCEPTANCE ===");
for (const [n, got, want] of checks) {
  const ok = got === want; if (!ok) bad++;
  console.log(`  ${ok ? "ok " : "XX "} ${n.padEnd(28)} got ${String(got).padStart(4)}  want ${want}`);
}

// ── EVERY CITY STRING THAT FAILED TO MAP, VERBATIM ───────────────────────────────────────────
const unmapped = new Map<string, number>();
let derived = 0, mapped = 0, notAsked = 0;
for (const p of parsed) {
  if (isOwnTestRow(p.email)) continue;
  const cityRaw = p.fields["City"] ?? p.fields["Location"] ?? "";
  const zip = p.fields["Zipcode"] ?? "";
  if (!cityRaw && !zip) { notAsked++; continue; }
  const c = resolveCity(cityRaw, zip);
  if (c.code && c.source === "zip") derived++;
  else if (c.code) mapped++;
  else unmapped.set(c.raw, (unmapped.get(c.raw) ?? 0) + 1);
}
console.log(`\n=== CITY ===\n  mapped ${mapped}   derived from zip ${derived}   no city field ${notAsked}   UNMAPPED ${[...unmapped.values()].reduce((a, b) => a + b, 0)} rows / ${unmapped.size} distinct strings`);
console.log("  every unmapped string, verbatim:");
for (const [s, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${JSON.stringify(s)}`);

if (bad > 0) { console.log(`\n${bad} acceptance check(s) FAILED — writing nothing.`); process.exit(1); }
if (!APPLY) { console.log("\nDRY RUN — counts match. Re-run with --apply to write."); process.exit(0); }

// Wrapped in an async IIFE: tsx emits CJS for a .ts script, which has no top-level await.
async function write() {
  // ── WRITE ────────────────────────────────────────────────────────────────────────────────────
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  
  const lb = await sb.from("web_form_labels").upsert(labelRows, { onConflict: "element_id,field_id" });
  if (lb.error) { console.log("LABELS FAILED:", lb.error.message); process.exit(1); }
  console.log(`\nweb_form_labels: ${labelRows.length} rows LANDED`);
  
  /* THE SHARED BUILDER, not a second copy of these decisions. A submission arriving by CSV and the
   * same submission arriving by API must produce a byte-identical row — web-submissions-parity-test
   * asserts exactly that, and it can only hold while there is ONE builder. */
  const registry: Record<string, FormLabels> = { ...PINNED_FORMS };
  for (const l of labelRows) {
    const cur = registry[l.element_id] ?? { elementId: l.element_id, formName: l.form_name, labels: {} as Record<string, string>, source: "csv" as const };
    if (!(l.element_id in PINNED_FORMS)) { (cur.labels as Record<string, string>)[l.field_id] = l.label; registry[l.element_id] = cur; }
  }
  const subRows = parsed
    .map((p) => toSubmissionRow({
      submissionId: p.submissionId, elementId: p.elementId, formName: p.formName,
      referer: p.referer, createdAt: p.createdAt, fields: p.fields,
    }, registry, "csv"))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  for (let i = 0; i < subRows.length; i += 300) {
    const { error } = await sb.from("web_submissions").upsert(subRows.slice(i, i + 300), { onConflict: "submission_id" });
    if (error) { console.log(`SUBMISSIONS FAILED at ${i}:`, error.message); process.exit(1); }
  }
  console.log(`web_submissions: ${subRows.length} rows LANDED`);
  
  /* CONTACTS ARE INSERTED, NEVER UPDATED. onConflict do-nothing: a re-run must not reset a status
   * someone set. 25 emails have more than one submission and one has ten. */
  const contacts = [...new Map(subRows.filter((r) => r.email && !r.is_spam)
    .map((r) => [`${r.stream}|${r.email}`, { stream: r.stream, email: r.email! }])).values()];
  const ct = await sb.from("web_contacts").upsert(contacts, { onConflict: "stream,email", ignoreDuplicates: true });
  if (ct.error) { console.log("CONTACTS FAILED:", ct.error.message); process.exit(1); }
  console.log(`web_contacts: ${contacts.length} rows LANDED (existing statuses untouched)`);
}
void write();
