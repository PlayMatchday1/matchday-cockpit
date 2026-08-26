// playmatchday.com form submissions — the PURE model. No network, no clock, no Supabase.
//
// Everything that decides what a submission MEANS lives here so it can be asserted against
// fixtures. The importer and the sync are thin: fetch, hand rows to these functions, write what
// they return.
//
// ── THE TRAP THIS FILE EXISTS FOR ──────────────────────────────────────────────────────────────
// Elementor stores the FIELD ID and never the label, and THE SAME ID MEANS DIFFERENT THINGS ON
// DIFFERENT FORMS. Proven on the live site:
//
//   key             partnerships (f7eed00)      team application (4e61155c)
//   field_dff8b68   Company                ->   Last Name
//   field_15bf1e3   Location               ->   City
//   message         Last Name              ->   Availability
//
// A single global key->label map is the obvious build and it files partner COMPANIES into
// applicants' SURNAMES. Every lookup here is therefore keyed on element_id first. There is no
// function in this module that takes a field id without one.

/** A form's label map. `source` records where the labels came from, because two of them differ. */
export type FormLabels = {
  elementId: string;
  formName: string;
  /** field id -> human label, AS THAT FORM USES IT. */
  labels: Readonly<Record<string, string>>;
  /** 'forms-api' = recoverable from ?forms=1. 'csv' = the form was edited or replaced and its
   *  labels exist only in the CSV export — four forms, 109 submissions. */
  source: "forms-api" | "csv";
};

/* ── THE REGISTRY, KEYED ON element_id ─────────────────────────────────────────────────────────
 * Only the two forms that still resolve from ?forms=1 are pinned here; the other four are loaded
 * from the CSV import and merged at runtime. The two pinned ones are the pair that PROVES the
 * collision, and they are the fixture the suite asserts against. */
/* ── THE REGISTRY, KEYED ON element_id ─────────────────────────────────────────────────────────
 * READ OFF THE LIVE ENDPOINT 2026-08-26, not transcribed from a description. An earlier version of
 * this map was written from the brief and had THREE WRONG FIELD IDS — field_2a1c0f4 for the vision
 * question (really field_187a8c9), and Job Role and Phone under ids that do not exist. Wrong pins
 * are worse than none: they resolve confidently to the wrong label.
 *
 * These two are a FALLBACK AND A FIXTURE, not the authority. ?forms=1 wins wherever it answers, and
 * the stored web_form_labels rows win over these — the merge order is
 * { ...PINNED_FORMS, ...stored, ...live } everywhere. They exist so the pure model and its suite
 * can assert the collision offline, and so a page read still labels these two forms if the labels
 * table is empty.
 *
 * THE COLLISION, AS THE SITE ACTUALLY REPORTS IT:
 *   field_dff8b68   Company   (f7eed00)   ->   Last Name    (4e61155c)
 *   field_15bf1e3   Location              ->   City
 *   message         Last Name             ->   Availability
 *
 * And one shared id that is NOT a collision: field_ffeb63a is "Phone" on both. Sameness is not the
 * rule — the rule is that the id means whatever ITS OWN form says it means. */
export const PINNED_FORMS: Readonly<Record<string, FormLabels>> = Object.freeze({
  f7eed00: {
    elementId: "f7eed00",
    formName: "Form partnerships",
    source: "forms-api",
    labels: Object.freeze({
      name: "First Name",
      message: "Last Name",
      field_dff8b68: "Company",
      email: "Email",
      field_15bf1e3: "Location",
      field_ffeb63a: "Phone",
      field_187a8c9: "Share Your Vision",
    }),
  },
  "4e61155c": {
    elementId: "4e61155c",
    formName: "Team Application",
    source: "forms-api",
    labels: Object.freeze({
      name: "First Name",
      field_dff8b68: "Last Name",
      email: "Email",
      field_15bf1e3: "City",
      field_cbcd9d0: "Job Role",
      field_ffeb63a: "Phone",
      message: "Availability",
      field_706ba38: "Why would you be a good fit for MatchDay?",
    }),
  },
});

/** A field the form never asked for. NOT the same as a field asked and left blank — 63 people have
 *  no Job Role because their form had no such field, and rendering that as "" invites someone to
 *  chase data that was never collected. */
export const NOT_ASKED = Symbol("not-asked");
export type FieldValue = string | typeof NOT_ASKED;

export type ResolvedSubmission = {
  /** label -> value, or NOT_ASKED. */
  byLabel: Record<string, FieldValue>;
  /** True when element_id is in no map. The raw keys are kept and the row is flagged rather than
   *  written with another form's labels — that is the 109 historical rows, and mislabelling them
   *  silently is the failure this whole module prevents. */
  unresolved: boolean;
};

/**
 * Resolve one submission's fields against ITS OWN form.
 *
 * `registry` is PINNED_FORMS merged with whatever the CSV/forms API supplied. An element_id that
 * is not in it returns `unresolved: true` and the RAW keys — never a guess, never another form's
 * labels.
 */
export function resolveFields(
  elementId: string,
  fields: Readonly<Record<string, unknown>>,
  registry: Readonly<Record<string, FormLabels>> = PINNED_FORMS,
): ResolvedSubmission {
  const form = registry[elementId];
  if (!form) {
    const byLabel: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(fields)) byLabel[k] = unescapeWpText(String(v ?? ""));
    return { byLabel, unresolved: true };
  }
  const byLabel: Record<string, FieldValue> = {};
  /* EITHER KEY RESOLVES, and this is not laxity — the two sources genuinely differ.
   *
   * The live endpoint returns Elementor's FIELD IDS (`field_dff8b68`). The CSV export returns
   * resolved LABELS as its column headers ("Company") and never the ids at all. Both describe the
   * same submission on the same form, so both must land in the same shape or the historical rows
   * and the synced rows would render differently on one page.
   *
   * The label is only accepted for the form that DECLARES it, so this cannot reintroduce the
   * collision: "Company" resolves on f7eed00 because f7eed00 declares it, and on 4e61155c there is
   * no such label to match. */
  let matched = 0;
  for (const [fieldId, label] of Object.entries(form.labels)) {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
    if (has(fieldId)) { byLabel[label] = unescapeWpText(String(fields[fieldId] ?? "")); matched++; }
    else if (has(label)) { byLabel[label] = unescapeWpText(String(fields[label] ?? "")); matched++; }
    else byLabel[label] = NOT_ASKED;
  }

  /* KNOWN FORM, ZERO MATCHES — STILL UNRESOLVED.
   *
   * A form can be in the registry and STILL not resolve this submission, and the first cut of this
   * function called that a success. The four forms the site can no longer describe have labels only
   * from the CSV, where the "field id" IS the label ("Email" -> "Email"). Those entries resolve a
   * CSV row perfectly and match NOTHING on an API row, which arrives keyed by real field ids
   * (`name`, `email`, `field_...`).
   *
   * The result was silent: every field came back NOT_ASKED, the email was empty, and because the
   * email was empty our own test rows stopped being recognised — the live pull built 655 rows where
   * the CSV built 647. Nothing was flagged, because the element_id was "known".
   *
   * So the test is whether anything ACTUALLY matched. Incoming keys but none of them ours means we
   * did not resolve this submission, whatever the registry claims, and the raw keys are kept.
   * An empty submission is not this case and is not flagged. */
  const incoming = Object.keys(fields).length;
  if (incoming > 0 && matched === 0) {
    const raw: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(fields)) raw[k] = unescapeWpText(String(v ?? ""));
    return { byLabel: raw, unresolved: true };
  }
  return { byLabel, unresolved: false };
}

/** Was this field asked at all? */
export const wasAsked = (v: FieldValue | undefined): boolean => v !== undefined && v !== NOT_ASKED;
/** Asked, and answered with something. */
export const hasValue = (v: FieldValue | undefined): boolean => wasAsked(v) && String(v).trim() !== "";

/* ── TEXT ──────────────────────────────────────────────────────────────────────────────────────
 * The export is escape-encoded: literal backslash-r-backslash-n and backslash-slash appear inside
 * Availability, Vision and Location. Unescaped ON IMPORT so no escape survives into the table —
 * a stored "\r\n" renders as those four characters on the page forever. */
export function unescapeWpText(raw: string): string {
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** Does any backslash escape survive? Asserted on import; a true here is a failed unescape. */
export const hasSurvivingEscape = (s: string): boolean => /\\[rnt"'/\\]/.test(s);

/* ── CITY — MAPPED, NEVER GUESSED ──────────────────────────────────────────────────────────────*/
export const CITY_TOWNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ATX: ["Austin", "Pflugerville", "Round Rock", "Manor", "Buda", "Hutto", "Georgetown", "Kyle", "Cedar Park", "Leander"],
  SATX: ["San Antonio", "Cibolo", "Canyon Lake", "New Braunfels", "Schertz"],
  HTX: ["Houston", "Katy", "Brookshire", "Pearland", "Sugar Land", "Cypress", "Tomball"],
  DFW: ["Dallas", "Irving", "Fort Worth", "Rowlett", "Denton", "Frisco", "Plano", "Celina", "Lewisville",
        "Little Elm", "Garland", "Aubrey", "Savannah", "Arlington", "The Colony", "Southlake", "McKinney", "Allen"],
  ATL: ["Atlanta", "Johns Creek", "Alpharetta", "Marietta", "Duluth"],
  OKC: ["Oklahoma City", "Edmond", "Norman"],
  STL: ["St. Louis", "O'Fallon", "Chesterfield"],
});

/** Display order, matching the mockup's chips. */
export const CITY_ORDER: readonly string[] = ["ATX", "DFW", "HTX", "SATX", "ATL", "OKC", "STL"];

/* NORMALISE HARD. "Austin Texas", "Austin, TX" and "Austin Tx" are one key, and the state suffix
 * has to go before the lookup or each spelling becomes its own miss. Punctuation is stripped
 * rather than mapped: "St. Louis", "St Louis" and "st.louis" must all land together, and
 * "John Creeks" is a real spelling of Johns Creek that appears in the data. */
export function normalizeCityText(raw: string): string {
  let t = unescapeWpText(raw).toLowerCase();
  t = t.replace(/[.,]/g, " ").replace(/[^a-z0-9\s'-]/g, " ");
  // Trailing state, spelled or abbreviated.
  t = t.replace(/\b(texas|tx|georgia|ga|oklahoma|ok|missouri|mo|usa|us|united states)\b/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

const TOWN_LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [code, towns] of Object.entries(CITY_TOWNS)) {
    for (const t of towns) m.set(normalizeCityText(t), code);
  }
  /* SPELLINGS SEEN IN THE DATA, pinned rather than fuzzy-matched. Johns Creek is the third-largest
   * cluster at 10 people and arrives as both "Johns creek" and "John Creeks"; a fuzzy matcher that
   * caught those would also catch things it should not. */
  m.set("john creeks", "ATL");
  m.set("john creek", "ATL");
  m.set("johns creeks", "ATL");
  m.set("ft worth", "DFW");
  m.set("saint louis", "STL");
  m.set("o fallon", "STL");
  return m;
})();

/** The city code for a typed city string, or null when it is not on the map. Never a guess. */
export function cityForText(raw: string): string | null {
  const key = normalizeCityText(raw);
  if (!key) return null;
  return TOWN_LOOKUP.get(key) ?? null;
}

/* ── ZIP — DERIVED, AND SAID TO BE ─────────────────────────────────────────────────────────────
 * 20 rows carry only a zipcode. A derived value that looks typed is one nobody will ever question,
 * so the caller gets `source: "zip"` and the page renders it differently. */
export const ZIP_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  "750": "DFW", "751": "DFW", "752": "DFW", "753": "DFW", "760": "DFW", "761": "DFW", "762": "DFW",
  "300": "ATL", "301": "ATL", "303": "ATL",
  "786": "ATX", "787": "ATX",
  "782": "SATX",
  "770": "HTX", "774": "HTX",
  "630": "STL", "631": "STL",
  "730": "OKC", "731": "OKC",
});

export function cityForZip(raw: string): string | null {
  const digits = unescapeWpText(raw).replace(/\D/g, "");
  if (digits.length < 5) return null;
  return ZIP_PREFIXES[digits.slice(0, 3)] ?? null;
}

export type CityResolution = { code: string | null; source: "city" | "zip" | "none"; raw: string };

/** Typed city first, zipcode only as a fallback, and the source always travels with the answer. */
export function resolveCity(rawCity: string | null | undefined, rawZip?: string | null): CityResolution {
  const city = (rawCity ?? "").trim();
  if (city) {
    const byText = cityForText(city);
    if (byText) return { code: byText, source: "city", raw: city };
    const byZipInCity = cityForZip(city);          // some people typed a zipcode into the city box
    if (byZipInCity) return { code: byZipInCity, source: "zip", raw: city };
    return { code: null, source: "none", raw: city };
  }
  const zip = (rawZip ?? "").trim();
  if (zip) {
    const c = cityForZip(zip);
    if (c) return { code: c, source: "zip", raw: zip };
  }
  return { code: null, source: "none", raw: city || zip };
}

/* ── SPAM — QUARANTINE, NEVER DELETE, AND NEVER ON LOCATION ────────────────────────────────────
 * 437 of 492 partnership rows are one bot. Measured signals:
 *
 *   name matches /Skync$/i                                437 of 437
 *   email domain registry.godaddy                         396 of 437
 *   company in {Nokia, Google, Apple, Wallmart, AliExpress}
 *
 * LOCATION IS DELIBERATELY NOT A SIGNAL. All 437 carry a location in
 * {Poland, France, UK, Germany, Georgia} — and GEORGIA IS A US STATE. Atlanta is in it and 83 of
 * those rows say Georgia, so a location rule silently bins real Atlanta partners. The mockup made
 * this mistake; this module must not inherit it.
 *
 * TWO OF THREE, and the row is KEPT with a flag. A rule that deletes cannot be audited when it is
 * wrong, and this one will be wrong eventually. */
/* SIX, NOT FIVE. The brief listed {Nokia, Google, Apple, Wallmart, AliExpress} = 380 rows. The
 * export carries a sixth — FBI, 57 rows — and 380 + 57 is exactly the 437 the bot is known to have
 * sent. Measured: nokia 85 · google 81 · apple 74 · wallmart 72 · aliexpress 68 · fbi 57. */
const SPAM_COMPANIES = new Set(["nokia", "google", "apple", "wallmart", "walmart", "aliexpress", "fbi"]);

export type SpamInput = { name?: string | null; email?: string | null; company?: string | null };

export function spamSignals(r: SpamInput): { skyncName: boolean; godaddyEmail: boolean; fakeCompany: boolean } {
  const name = unescapeWpText(String(r.name ?? ""));
  const email = String(r.email ?? "").trim().toLowerCase();
  const company = normalizeCityText(String(r.company ?? ""));   // same punctuation-stripping normaliser
  return {
    /* CONTAINS, NOT ENDS-WITH — and this is the correction that mattered. The brief specified
     * /Skync$/i "437 of 437". Against the export that regex matches ZERO rows: the token appears
     * INSIDE the name, never at the end. Anchored, the signal contributed nothing and the rule
     * caught 347 instead of 437. Measured: 437 of 437 contain it. */
    skyncName: /skync/i.test(name),
    godaddyEmail: /(^|[@.])registry\.godaddy$/.test(email.split("@")[1] ?? ""),
    fakeCompany: SPAM_COMPANIES.has(company),
  };
}

export function isSpam(r: SpamInput): boolean {
  const s = spamSignals(r);
  return [s.skyncName, s.godaddyEmail, s.fakeCompany].filter(Boolean).length >= 2;
}

/* ── OUR OWN TEST ROWS ─────────────────────────────────────────────────────────────────────────*/
export const EXCLUDED_EMAILS: ReadonlySet<string> = new Set([
  "rmancuso1@gmail.com",
  "rmancuso@playmatchday.com",
]);
export const isOwnTestRow = (email: string | null | undefined): boolean =>
  EXCLUDED_EMAILS.has(String(email ?? "").trim().toLowerCase());

/* ── CONTACT IDENTITY ──────────────────────────────────────────────────────────────────────────
 * Outreach state attaches to the PERSON, not the submission: 25 emails have more than one, and
 * one has ten. The key is (stream, lower(email)) so a second application never resets a status. */
export type Stream = "team" | "partner";
export const contactKey = (stream: Stream, email: string): string =>
  `${stream}|${email.trim().toLowerCase()}`;

export const STATUSES = ["New", "Contacted", "Interviewing", "Hired", "Passed"] as const;
export type Status = (typeof STATUSES)[number];
export const DEFAULT_STATUS: Status = "New";


/* ── THE ONE ROW BUILDER, SHARED BY THE CSV IMPORT AND THE LIVE SYNC ───────────────────────────
 *
 * A submission that arrives by CSV and the same submission arriving by API must produce a
 * BYTE-IDENTICAL row. Two builders would drift the first time either side changed — the exclusion
 * of our own test rows, the escape decoding, the spam signals and the city mapping would all have
 * to be kept in step by hand, and one of them would eventually not be.
 *
 * So there is one function and both callers use it. `web-submissions-parity-test` asserts the two
 * paths agree on the same input.
 *
 * NOTE THE ASYMMETRY IT ABSORBS: the CSV keys fields by LABEL ("Company") and the API keys them by
 * FIELD ID ("field_dff8b68"). resolveFields accepts either — but only on the form that DECLARES
 * the label, which is what stops label-keying reintroducing the id collision. */
export type RawSubmission = {
  submissionId: number;
  elementId: string;
  formName: string | null;
  referer: string | null;
  /** Any parseable timestamp; stored as an ISO instant. */
  createdAt: string | null;
  /** Keyed by field id (API) or by label (CSV). Values may still carry escapes. */
  fields: Record<string, unknown>;
};

export type SubmissionRowOut = {
  submission_id: number;
  element_id: string;
  form_name: string | null;
  referer: string | null;
  created_at: string | null;
  fields: Record<string, string>;
  stream: Stream;
  email: string | null;
  city_code: string | null;
  city_source: "city" | "zip" | "none";
  city_raw: string | null;
  is_spam: boolean;
  unresolved: boolean;
  imported_from: "csv" | "sync";
};

/** The partnerships form is the only partner stream; everything else is a team application. */
export const streamFor = (elementId: string): Stream => (elementId === "f7eed00" ? "partner" : "team");

export function toSubmissionRow(
  raw: RawSubmission,
  registry: Readonly<Record<string, FormLabels>>,
  importedFrom: "csv" | "sync",
): SubmissionRowOut | null {
  const { byLabel, unresolved } = resolveFields(raw.elementId, raw.fields, registry);

  // Values, unescaped exactly once, with NOT_ASKED collapsed away for storage — the table records
  // what the form CARRIED, and "never asked" is recoverable from the registry on read.
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(byLabel)) {
    if (v === NOT_ASKED) continue;
    const clean = unescapeWpText(String(v));
    if (hasSurvivingEscape(clean)) {
      throw new Error(`escape survived unescape on submission ${raw.submissionId} field ${k}`);
    }
    fields[k] = clean;
  }

  const email = String(fields["Email"] ?? "").trim().toLowerCase();

  /* OUR OWN TEST ROWS NEVER REACH THE TABLE, BY EITHER PATH — including when the row did not
   * resolve. On an UNRESOLVED row there is no "Email" label to read, so the address is invisible to
   * the check above: the live pull built 655 rows where the CSV built 647, and the eight extra were
   * ours on the four forms the site can no longer describe. So the raw VALUES are scanned too.
   * Exact match only — a substring test would drop a real applicant whose message quoted us. */
  if (email && isOwnTestRow(email)) return null;
  if (!email) {
    for (const v of Object.values(fields)) if (isOwnTestRow(String(v))) return null;
  }

  const stream = streamFor(raw.elementId);
  const city = resolveCity(fields["City"] ?? fields["Location"] ?? "", fields["Zipcode"] ?? fields["Zip"] ?? "");

  return {
    submission_id: raw.submissionId,
    element_id: raw.elementId,
    form_name: raw.formName ?? null,
    referer: raw.referer || null,
    created_at: toIso(raw.createdAt),
    fields,
    stream,
    email: email || null,
    city_code: city.code,
    city_source: city.source,
    city_raw: city.raw || null,
    // Spam is a PARTNER-stream judgement and never keys on location.
    is_spam: stream === "partner" && isSpam({
      name: `${fields["First Name"] ?? ""} ${fields["Last Name"] ?? ""}`,
      email,
      company: fields["Company"] ?? "",
    }),
    unresolved,
    imported_from: importedFrom,
  };
}

/** "2026-08-24 13:05:11" and "2026-08-24T13:05:11Z" both mean the same instant here — the export
 *  uses a space, the API uses a T. An unparseable value is null, never a fabricated now(). */
export function toIso(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const norm = /^\d{4}-\d{2}-\d{2} /.test(t) ? `${t.replace(" ", "T")}Z` : t;
  const ms = Date.parse(norm);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
