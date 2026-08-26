// APPLICATIONS — the pure shaping model. One submission row set in, one list of PEOPLE out.
//
// WHY PEOPLE AND NOT SUBMISSIONS. Outreach attaches to the person: 25 emails have more than one
// submission and one has ten. The page lists people, each carrying how many times they applied and
// when they first did, so a repeat applicant reads as one candidate with history rather than as
// ten rows that each need contacting.
//
// No network, no clock passed implicitly — `nowMs` is an argument so the suites can pin it.

import {
  resolveFields, wasAsked, hasValue, NOT_ASKED, resolveCity, isSpam, isOwnTestRow,
  type FormLabels, type Stream, type Status, DEFAULT_STATUS,
} from "./webSubmissions";

export type SubmissionRow = {
  submission_id: number;
  element_id: string;
  form_name: string | null;
  created_at: string | null;
  fields: Record<string, unknown>;
  stream: Stream;
};

export type ContactRow = { stream: Stream; email: string; status: Status; owner: string | null; notes: string | null };

/** A field on the page. `asked:false` renders as "not asked" — never as an empty box. */
export type Field = { value: string; asked: boolean };
const field = (v: unknown): Field =>
  v === undefined || v === NOT_ASKED
    ? { value: "", asked: false }
    : { value: String(v), asked: true };

export type Person = {
  email: string;
  stream: Stream;
  name: string;
  lastName: Field;
  phone: Field;
  company: Field;          // partner stream
  role: Field;             // team stream — 63 people were never asked
  availability: Field;
  why: Field;
  vision: Field;
  cityCode: string | null;
  cityName: string | null;
  citySource: "city" | "zip" | "none";
  cityRaw: string;
  applied: string;         // most recent, YYYY-MM-DD
  firstApplied: string;
  submissions: number;
  unresolved: boolean;
  spam: boolean;
  status: Status;
  owner: string | null;
  notes: string | null;
};

export const CITY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ATX: "Austin", DFW: "Dallas", HTX: "Houston", SATX: "San Antonio",
  ATL: "Atlanta", OKC: "Oklahoma City", STL: "St. Louis",
});

const pick = (byLabel: Record<string, unknown>, ...labels: string[]): unknown => {
  for (const l of labels) if (l in byLabel) return byLabel[l];
  return undefined;
};

/**
 * Fold submissions into people.
 *
 * DEDUPE IS BY (stream, lower(email)) — the same key web_contacts uses, so the join can never
 * disagree with the grouping. The NEWEST submission supplies the displayed fields; older ones
 * contribute only to the count and the first-applied date, because the most recent answer is the
 * one worth acting on.
 *
 * OUR OWN TEST ROWS AND SPAM ARE MARKED, NOT DROPPED. The caller decides what to show; a filter
 * that deletes cannot be audited when it is wrong.
 */
export function buildPeople(
  rows: readonly SubmissionRow[],
  contacts: readonly ContactRow[],
  registry: Readonly<Record<string, FormLabels>>,
): Person[] {
  const byContact = new Map(contacts.map((c) => [`${c.stream}|${c.email.toLowerCase()}`, c]));
  const groups = new Map<string, SubmissionRow[]>();

  for (const r of rows) {
    const { byLabel } = resolveFields(r.element_id, r.fields, registry);
    const email = String(pick(byLabel, "Email") ?? "").trim().toLowerCase();
    if (!email) continue;                       // no email = no person to contact
    if (isOwnTestRow(email)) continue;          // 12 of Ryan's own test rows
    const key = `${r.stream}|${email}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }

  const out: Person[] = [];
  for (const [key, subs] of groups) {
    const [stream, email] = key.split("|") as [Stream, string];
    // Newest first; the newest supplies the fields.
    subs.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const newest = subs[0];
    const { byLabel, unresolved } = resolveFields(newest.element_id, newest.fields, registry);

    const first = String(pick(byLabel, "First Name", "Name") ?? "").trim();
    const last = field(pick(byLabel, "Last Name"));
    const company = field(pick(byLabel, "Company"));
    const cityRawVal = String(pick(byLabel, "City", "Location") ?? "").trim();
    const zipVal = String(pick(byLabel, "Zipcode", "Zip", "Postcode") ?? "").trim();
    const city = resolveCity(cityRawVal, zipVal);

    out.push({
      email, stream,
      name: [first, last.asked ? last.value : ""].filter(Boolean).join(" ").trim() || email,
      lastName: last,
      phone: field(pick(byLabel, "Phone")),
      company,
      role: field(pick(byLabel, "Job Role", "Role")),
      availability: field(pick(byLabel, "Availability")),
      why: field(pick(byLabel, "Why would you be a good fit for MatchDay?", "Why MatchDay")),
      vision: field(pick(byLabel, "Share Your Vision", "Vision")),
      cityCode: city.code,
      cityName: city.code ? CITY_NAMES[city.code] ?? city.code : null,
      citySource: city.source,
      cityRaw: city.raw,
      applied: String(newest.created_at ?? "").slice(0, 10),
      firstApplied: String(subs[subs.length - 1].created_at ?? "").slice(0, 10),
      submissions: subs.length,
      unresolved,
      // Spam is judged on the NEWEST submission's own fields — never on location.
      spam: stream === "partner" && isSpam({
        name: [first, last.asked ? last.value : ""].join(" "),
        email,
        company: company.asked ? company.value : "",
      }),
      status: byContact.get(key)?.status ?? DEFAULT_STATUS,
      owner: byContact.get(key)?.owner ?? null,
      notes: byContact.get(key)?.notes ?? null,
    });
  }

  // MOST RECENT FIRST. Nothing else until asked.
  out.sort((a, b) => b.applied.localeCompare(a.applied) || a.name.localeCompare(b.name));
  return out;
}

/** Days between a YYYY-MM-DD and now. String maths on the date, so no wall-clock re-shift. */
export function daysSince(ymd: string, nowMs: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - Date.parse(`${ymd}T00:00:00Z`)) / 86400000);
}

export type Tiles = { k: string; v: string; h: string; tone?: "hot" | "good" }[];

/** The five tiles, per the mockup — different sets per stream. */
export function buildTiles(
  people: readonly Person[], stream: Stream, nowMs: number,
  /* TWO DIFFERENT UNITS, NAMED SEPARATELY. `spamSubmissions` is rows (437); `spamSenders` is the
   * distinct addresses behind them (24). The tile first read "SPAM FILTERED 24" beside "487 rows
   * in" — two units in one card, and 24 looked like a rounding of nothing. */
  raw: { submissions: number; spamSubmissions: number; spamSenders: number },
): Tiles {
  const n = people.length;
  const untouched = people.filter((p) => p.status === "New").length;
  const recent = people.filter((p) => daysSince(p.applied, nowMs) <= 30).length;
  const noCity = people.filter((p) => !p.cityCode).length;
  if (stream === "team") {
    const bench = Object.keys(CITY_NAMES)
      .filter((c) => people.filter((p) => p.cityCode === c && p.status !== "Passed").length >= 2).length;
    return [
      { k: "Applicants", v: String(n), h: `${raw.submissions} submissions, deduped by email` },
      { k: "Not contacted", v: String(untouched), h: "no outreach recorded", tone: "hot" },
      { k: "Last 30 days", v: String(recent), h: "still warm" },
      { k: "Cities with a bench", v: `${bench} of 7`, h: "2 or more live candidates", tone: "good" },
      { k: "No city", v: String(noCity), h: "form didn't ask, or unrecognised" },
    ];
  }
  return [
    { k: "Partner leads", v: String(n), h: `${raw.submissions} rows in, deduped by email` },
    { k: "Not contacted", v: String(untouched), h: "no outreach recorded", tone: "hot" },
    { k: "Last 30 days", v: String(recent), h: "still warm" },
    { k: "Quarantined", v: String(raw.spamSubmissions), h: `submissions from ${raw.spamSenders} addresses — kept, not deleted` },
    { k: "No city", v: String(noCity), h: "free-text location, unrecognised" },
  ];
}

/** Search across the fields a person is actually findable by. Never across notes — those are ours. */
export function matchesSearch(p: Person, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const hay = [p.name, p.email, p.phone.value, p.company.value, p.cityRaw, p.cityName ?? "", p.role.value]
    .join(" ").toLowerCase();
  return hay.includes(t);
}

export { wasAsked, hasValue };
