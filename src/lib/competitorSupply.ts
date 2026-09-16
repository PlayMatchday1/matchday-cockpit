// COMPETITOR SUPPLY — the unit, the ordering, and the name matching. One module, no components.
//
// ══ MD STANDARD IS DERIVED HERE AND NOWHERE ELSE ═════════════════════════════════════════════
// One MatchDay match is 18 bookable spots. It is the only figure comparable across formats,
// because a 5v5 slot and an 11v11 slot are not the same match. There is no column for it in the
// database and no component divides by 18: a stored or re-derived figure is a second number that
// can disagree with the first, and this one goes in front of Ryan next to a share percentage.
//
// ══ matches_per_week IS STORED AND IS NOT SHOWN ══════════════════════════════════════════════
// It does not reconcile with the formats. Measured on the Sep 2026 capture: Memorial Indoor Soccer
// reports 2 matches and 70 spots at 5v5 (35 spots a match against an implied 10), Vaqueros Field
// 7 and 203 at 7v7 (29 against 14). Whatever a "match" means inside those apps, SPOTS is what was
// counted, so spots orders the rows and MD Standard is the match number on screen.

/** One MatchDay match, in bookable spots. The whole comparison rests on this. */
export const MD_STANDARD_SPOTS = 18;

/** Bookable spots expressed as MatchDay matches. The ONLY division by 18 in the codebase. */
export function mdStandard(spots: number): number {
  if (!Number.isFinite(spots)) return 0;
  return spots / MD_STANDARD_SPOTS;
}

/** MD Standard, rendered. One decimal, because 10 spots is 0.6 and must not round to zero. */
export function fmtMdStandard(spots: number): string {
  return mdStandard(spots).toFixed(1);
}

/* ── FORMATS ──────────────────────────────────────────────────────────────────────────────────
 * ORDERED BY THE NUMBER, NOT THE ALPHABET. "10v10" sorts before "5v5" as a string, and a format
 * list that reads 10v10, 11v11, 5v5 is the tell that somebody sorted it as text.
 *
 * BUILT FROM THE DATA, never from a hardcoded array, so a format nobody has captured yet appears
 * the first time it is. */
export function formatSize(fmt: string): number {
  const m = /^(\d+)\s*v/i.exec(String(fmt).trim());
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

export function sortFormats(formats: Iterable<string>): string[] {
  return [...new Set([...formats].map((f) => String(f).trim()).filter(Boolean))]
    .sort((a, b) => formatSize(a) - formatSize(b) || a.localeCompare(b));
}

/** Spots one match of this format implies, for the capture-quality check. 7v7 is 14 players. */
export function impliedSpotsPerMatch(formats: string[]): number | null {
  const sizes = formats.map(formatSize).filter((n) => Number.isFinite(n));
  if (sizes.length === 0) return null;
  return (2 * sizes.reduce((a, b) => a + b, 0)) / sizes.length;
}

/* ── PRICE ────────────────────────────────────────────────────────────────────────────────────
 * CENTS IN, TEXT OUT. Price is a NUMBER on the page, right aligned, never a position on an axis:
 * the first cut drew each facility as a segment on a shared $6 to $16 scale and Ryan's verdict was
 * "the price per player makes no sense $600. I dont know what its trying to capture." A column
 * that needs a legend has failed.
 *
 * BOTH NULL IS "not shown", WHICH IS NOT $0. A facility that published no price told us nothing;
 * rendering that as zero would make it the cheapest thing in the city. */
export type PriceRange = { lowCents: number | null; highCents: number | null };

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function fmtPrice(p: PriceRange): { text: string; shown: boolean } {
  const { lowCents: lo, highCents: hi } = p;
  if (lo == null && hi == null) return { text: "not shown", shown: false };
  if (lo != null && hi != null) {
    // A SINGLE PRICE IS NOT WRITTEN TWICE.
    return { text: lo === hi ? dollars(lo) : `${dollars(lo)} to ${dollars(hi)}`, shown: true };
  }
  return { text: dollars((lo ?? hi) as number), shown: true };
}

/** The floor of a facility's published price, or null when it published none. */
export const priceFloor = (p: PriceRange): number | null =>
  p.lowCents ?? p.highCents ?? null;

/**
 * Does this facility undercut us? The one comparison worth keeping, and it is said in WORDS on the
 * row rather than drawn. A facility with no published price does not undercut anybody.
 */
export function undercutsUs(p: PriceRange, ourFloorCents: number | null): boolean {
  const floor = priceFloor(p);
  if (floor == null || ourFloorCents == null) return false;
  return floor < ourFloorCents;
}

/** The median of a set of price floors, in cents. Null when nothing published a price. */
export function medianFloorCents(rows: PriceRange[]): number | null {
  const xs = rows.map(priceFloor).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/* ── THE WINDOW ───────────────────────────────────────────────────────────────────────────────
 * A window is a pair of calendar dates and is compared as TEXT. Both ends are plain YYYY-MM-DD
 * with no zone; constructing a Date from one and reading it back is the wall-clock trap. */
export const windowDays = (startIso: string, endIso: string): number => {
  const a = Date.parse(`${startIso}T00:00:00Z`), b = Date.parse(`${endIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15 to 21 Sep". Built from the characters, never through a Date with a time. */
export function fmtWindow(startIso: string, endIso: string): string {
  const [, sm, sd] = startIso.split("-");
  const [, em, ed] = endIso.split("-");
  const a = `${Number(sd)}${sm === em ? "" : ` ${MON[Number(sm) - 1]}`}`;
  return `${a} to ${Number(ed)} ${MON[Number(em) - 1]}`;
}

/* ── NAME MATCHING, WHICH ONLY EVER PROPOSES ──────────────────────────────────────────────────
 * NEVER AUTO-LINK. "Athlete Training & Health | Cypress" and "Athlete Training and Health | Katy"
 * differ by one word and are different places, one of which is ours. our_venue_id stays NULL until
 * a person accepts a proposal.
 *
 * The stoplist is the words every soccer facility in America has in its name. Leaving "soccer" and
 * "park" in makes "North Park Soccer Fields" a 50% match for "Bicentennial Park", which is how a
 * plausible wrong link gets made. */
const NAME_STOP = new Set([
  "the", "and", "at", "of", "on", "for",
  "soccer", "sports", "sport", "field", "fields", "park", "complex", "center", "centre",
  "academy", "club", "indoor", "outdoor", "arena", "futbol", "football", "fc", "training", "health",
]);

export const normalizeName = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function nameTokens(s: string): string[] {
  return normalizeName(s).split(" ").filter((w) => w.length > 2 && !NAME_STOP.has(w));
}

/**
 * Initials of every word except the articles. "Athlete Training and Health" reduces to "ath".
 *
 * DELIBERATELY NOT THE STOPLIST. "training" and "health" are stoplisted for token overlap because
 * every facility in America has them, but they are exactly the words whose initials spell ATH.
 * Running this over the significant words only gave "ak" and the abbreviation arm never fired.
 */
const INITIAL_SKIP = new Set(["the", "and", "at", "of", "on", "for"]);
export function nameInitials(s: string): string {
  return normalizeName(s).split(" ").filter((w) => w && !INITIAL_SKIP.has(w)).map((w) => w[0]).join("");
}

export type NameCandidate = { venueId: number; venueName: string; via: string };
export type NameProposal = {
  facility: string;
  venueId: number | null;
  venueName: string | null;
  via: string | null;
  score: number;
  why: string;
};

/**
 * Score one facility name against one of our names. 1 is a confident proposal, anything under
 * PROPOSE_AT is reported as a near-miss and linked to nothing.
 *
 * THE ABBREVIATION ARM exists for exactly one real case and is deliberately narrow: a short token
 * on one side that is the INITIALS of the significant words on the other, with at least one shared
 * token to anchor it. "ATH Katy" against "Athlete Training and Health | Katy" shares "katy" and
 * "ath" is the initials of the rest. Without the anchor it would also match ATH Cypress.
 */
export function scoreName(facility: string, ourName: string): { score: number; why: string } {
  const A = nameTokens(facility), B = nameTokens(ourName);
  if (A.length === 0 || B.length === 0) return { score: 0, why: "no significant words" };
  const inter = A.filter((x) => B.includes(x));
  let score = inter.length / Math.min(A.length, B.length);
  let why = inter.length ? `shares ${inter.map((w) => `"${w}"`).join(", ")}` : "no shared word";
  /* ONE SHARED WORD AGAINST A ONE-WORD NAME IS NOT A MATCH, it is a coincidence with a good
   * denominator. Our venue "Hattrick T." reduces to the single token "hattrick", which scores a
   * perfect 1.00 against BOTH "The HatTrick Oakridge" and "The HatTrick Patio" — two different
   * Houston locations of the same chain, at most one of which is ours. The name cannot decide it,
   * so the score must not pretend it can. */
  if (Math.min(A.length, B.length) === 1 && Math.max(A.length, B.length) > 1) {
    score = Math.min(score, 0.6);
    why += `, but "${(A.length === 1 ? A : B)[0]}" is the whole of one name and cannot tell two locations apart`;
  }
  if (inter.length > 0) {
    const aInit = nameInitials(facility), bInit = nameInitials(ourName);
    const abbrB = B.find((b) => b.length >= 2 && b.length <= 5 && aInit.startsWith(b) && !A.includes(b));
    const abbrA = A.find((a) => a.length >= 2 && a.length <= 5 && bInit.startsWith(a) && !B.includes(a));
    const abbr = abbrB ?? abbrA;
    if (abbr && score >= 0.4) { score = Math.max(score, 0.9); why += ` and "${abbr}" is the initials of the rest`; }
  }
  return { score: Math.min(score, 1), why };
}

/** At or above this, the importer proposes a link for a person to accept. */
export const PROPOSE_AT = 0.85;

export function proposeLink(facility: string, candidates: NameCandidate[]): NameProposal {
  let best: NameProposal = { facility, venueId: null, venueName: null, via: null, score: 0, why: "nothing close" };
  for (const c of candidates) {
    const { score, why } = scoreName(facility, c.via);
    if (score > best.score) best = { facility, venueId: c.venueId, venueName: c.venueName, via: c.via, score, why };
  }
  if (best.score < PROPOSE_AT) return { ...best, venueId: null };
  return best;
}

/* ── THE CAPTURE FILE ─────────────────────────────────────────────────────────────────────────
 * Ryan captures per region, by hand, through an emulator with mocked GPS, and Plei is in about
 * 38 regions. This will happen many times, so the shape is fixed and the parser is strict.
 *
 * REJECT THE WHOLE FILE ON ANY BAD ROW. A partial import of a competitor capture is worse than
 * no import, because the totals will look plausible. */
const COLUMNS = [
  "source", "city_label", "window_start", "window_end", "window_note", "facility",
  "matches_per_week", "bookable_spots_per_week", "price_low", "price_high", "formats",
] as const;

/** A real CSV split. The capture has "Crossbar, Rowlett" in it; a naive split on comma renames it. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Dollars as written in the file to integer cents. "12.50" is 1250 and never 12.5. */
function toCents(raw: string, where: string, errs: string[]): number | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\$?\d+(\.\d{1,2})?$/.test(t)) { errs.push(`${where}: "${raw}" is not a price`); return null; }
  return Math.round(Number(t.replace("$", "")) * 100);
}

export type ParsedRow = {
  source: string; city_label: string; window_start: string; window_end: string;
  window_note: string | null; facility: string; matches_per_week: number | null;
  bookable_spots_per_week: number; price_low_cents: number | null; price_high_cents: number | null;
  formats: string[];
};

export function parseCapture(text: string): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], errors: ["The file is empty."] };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  /* AN UNKNOWN COLUMN REJECTS THE FILE. A capture with a column we do not understand is a capture
   * whose shape changed, and importing the columns we recognise would silently drop the rest. */
  const unknown = header.filter((h) => !(COLUMNS as readonly string[]).includes(h));
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (unknown.length) errors.push(`Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  if (missing.length) errors.push(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  if (errors.length) return { rows: [], errors };

  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const where = `row ${i + 1}`;
    if (c.length !== header.length) { errors.push(`${where}: ${c.length} fields, expected ${header.length}`); continue; }
    const g = (k: string) => c[idx[k]] ?? "";
    const source = g("source").toLowerCase();
    if (source !== "plei" && source !== "goodrec") { errors.push(`${where}: unknown source "${g("source")}"`); continue; }
    for (const k of ["window_start", "window_end"]) {
      if (!DATE_RX.test(g(k))) errors.push(`${where}: ${k} "${g(k)}" is not YYYY-MM-DD`);
    }
    if (g("window_end") < g("window_start")) errors.push(`${where}: window_end is before window_start`);
    if (!g("facility")) errors.push(`${where}: facility is blank`);
    const spotsRaw = g("bookable_spots_per_week");
    if (!/^\d+$/.test(spotsRaw)) errors.push(`${where}: bookable_spots_per_week "${spotsRaw}" is not a whole number`);
    const mpwRaw = g("matches_per_week");
    if (mpwRaw !== "" && !/^\d+(\.\d+)?$/.test(mpwRaw)) errors.push(`${where}: matches_per_week "${mpwRaw}" is not a number`);
    const lo = toCents(g("price_low"), where, errors);
    const hi = toCents(g("price_high"), where, errors);
    if (lo != null && hi != null && hi < lo) errors.push(`${where}: price_high is below price_low`);
    rows.push({
      source, city_label: g("city_label"),
      window_start: g("window_start"), window_end: g("window_end"),
      window_note: g("window_note") || null, facility: g("facility"),
      matches_per_week: mpwRaw === "" ? null : Number(mpwRaw),
      bookable_spots_per_week: Number(spotsRaw) || 0,
      price_low_cents: lo, price_high_cents: hi,
      formats: sortFormats(g("formats").split("|")),
    });
  }
  if (!rows.length && !errors.length) errors.push("The file has a header and no rows.");
  return { rows: errors.length ? [] : rows, errors };
}

/* ── WHEN MAY A SHARE BE A PERCENTAGE ─────────────────────────────────────────────────────────
 *
 * LENGTH, AND ONLY LENGTH. Two windows of the same number of days are comparable whether or not
 * they start on the same date: Plei DFW is Tue 15 to Mon 21 and GoodRec DFW is Wed 16 to Tue 22,
 * both seven days, one of each weekday, and a week of supply is a week of supply. The dates are on
 * the city heading for anyone who wants to check the offset.
 *
 * THE NOTE IS NOT AN INPUT. It used to be, and it was wrong: the Plei DFW capture was annotated
 * "not a clean 7 days" and that annotation alone made the page refuse to divide. The match log
 * settled it — 7 distinct dates, 2026-09-15 through 2026-09-21, one of each weekday, 211 matches —
 * so the note was mistaken and the length check had been right all along. A free-text note can now
 * say anything at all and this function will not read it.
 *
 * WHAT STILL REACHES THE REFUSAL: a capture whose window is a different NUMBER of days from ours.
 * Nothing in the September data does, so the branch is unreachable today, but a fortnight-long or
 * three-day capture would, and dividing that against our seven is the number that ends up in a
 * deck without its caveat. */
export type WindowSpec = { source: string; start: string; end: string; note?: string | null };

export type Alignment =
  | { aligned: true; days: number }
  | { aligned: false; reasons: string[] };

export function windowsAlign(ours: { start: string; end: string }, theirs: WindowSpec[]): Alignment {
  if (theirs.length === 0) return { aligned: false, reasons: ["nothing has been captured"] };
  const ourDays = windowDays(ours.start, ours.end);
  const reasons: string[] = [];
  for (const t of theirs) {
    const d = windowDays(t.start, t.end);
    if (d !== ourDays) reasons.push(`${t.source} covers ${d} days against our ${ourDays}`);
  }
  return reasons.length ? { aligned: false, reasons } : { aligned: true, days: ourDays };
}

/* ── THE MATCH LOG ────────────────────────────────────────────────────────────────────────────
 * A DIFFERENT GRAIN from the weekly summary, and the two agreeing is the whole validation: the
 * September log sums to exactly the three capture totals, 360/4,710, 211/2,789 and 114/1,781.
 *
 * THE LOG NAMES FIELDS, THE SUMMARY NAMES FACILITIES. Three log names have no summary row, and
 * merging them is justified by ARITHMETIC rather than by the names looking similar:
 *
 *   Q&B Indoor Sports 56 spots + "- Sphere" 15  = 71, and the summary says 71.
 *   ATH Cypress "and" spelling 22 + "- Cypress | Morby" 120 = 142, and the summary says 142.
 *
 * That is proof. It is also why this map is a LIST OF MEASURED PAIRS and not a fuzzy matcher: the
 * two Cypress variants stay on the CYPRESS row, which is not one of ours, and nothing here can
 * drift them onto ATH Katy, which is. */
export const MATCHLOG_FACILITY_ALIASES: Record<string, string> = {
  "Q&B Indoor Sports - Sphere": "Q&B Indoor Sports",
  "Athlete Training and Health | Cypress": "Athlete Training & Health | Cypress",
  "Athlete Training & Health - Cypress | Morby": "Athlete Training & Health | Cypress",
};

export const resolveLogFacility = (facility: string): string =>
  MATCHLOG_FACILITY_ALIASES[facility] ?? facility;

const LOG_COLUMNS = [
  "source", "city_label", "facility", "match_date", "kickoff_local", "duration_minutes", "format",
  "bookable_spots", "price", "listing_title", "note",
] as const;

export type ParsedMatch = {
  source: string; city_label: string; facility: string; resolved_facility: string;
  match_date: string; kickoff_local: string | null; duration_minutes: number | null;
  format: string; spots: number; price_cents: number | null;
  listing_title: string | null; note: string | null;
};

const TIME_RX = /^(\d{1,2}):(\d{2})(:\d{2})?$/;

export function parseMatchLog(text: string): { rows: ParsedMatch[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], errors: ["The file is empty."] };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const unknown = header.filter((h) => !(LOG_COLUMNS as readonly string[]).includes(h));
  const missing = LOG_COLUMNS.filter((c) => !header.includes(c));
  if (unknown.length) errors.push(`Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  if (missing.length) errors.push(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  if (errors.length) return { rows: [], errors };

  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const rows: ParsedMatch[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const where = `row ${i + 1}`;
    if (c.length !== header.length) { errors.push(`${where}: ${c.length} fields, expected ${header.length}`); continue; }
    const g = (k: string) => c[idx[k]] ?? "";
    const source = g("source").toLowerCase();
    if (source !== "plei" && source !== "goodrec") { errors.push(`${where}: unknown source "${g("source")}"`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g("match_date"))) errors.push(`${where}: match_date "${g("match_date")}" is not YYYY-MM-DD`);
    /* A BLANK TIME IS A REAL VALUE, NOT A BAD ROW. One listing was recorded with its time cut off;
     * dropping it would break the sum that validates the capture. */
    const rawTime = g("kickoff_local").trim();
    let kickoff: string | null = null;
    if (rawTime !== "") {
      const m = TIME_RX.exec(rawTime);
      if (!m) errors.push(`${where}: kickoff_local "${rawTime}" is not HH:MM`);
      else kickoff = `${m[1].padStart(2, "0")}:${m[2]}:00`;
    }
    if (!g("facility")) errors.push(`${where}: facility is blank`);
    if (!/^\d+$/.test(g("bookable_spots"))) errors.push(`${where}: bookable_spots "${g("bookable_spots")}" is not a whole number`);
    /* BLANK PRICE IS NULL, A WRITTEN 0 IS ZERO. The log has exactly one genuine free game and six
     * rows where nothing was published; reading either as the other misprices a market. */
    const rawPrice = g("price").trim();
    let priceCents: number | null = null;
    if (rawPrice !== "") {
      if (!/^\$?\d+(\.\d{1,2})?$/.test(rawPrice)) errors.push(`${where}: price "${rawPrice}" is not a price`);
      else priceCents = Math.round(Number(rawPrice.replace("$", "")) * 100);
    }
    /* BLANK DURATION IS NORMAL, NOT BAD. Every GoodRec row has none because GoodRec publishes a
     * start time only. A zero would be a broken slot, so it is refused; blank is not. */
    const rawDur = g("duration_minutes").trim();
    let duration: number | null = null;
    if (rawDur !== "") {
      if (!/^\d+$/.test(rawDur) || Number(rawDur) <= 0) errors.push(`${where}: duration_minutes "${rawDur}" is not a positive whole number of minutes`);
      else duration = Number(rawDur);
    }
    rows.push({
      source, city_label: g("city_label"), facility: g("facility"),
      resolved_facility: resolveLogFacility(g("facility")),
      match_date: g("match_date"), kickoff_local: kickoff, duration_minutes: duration,
      format: g("format").trim(),
      spots: Number(g("bookable_spots")) || 0, price_cents: priceCents,
      listing_title: g("listing_title").trim() || null,
      note: g("note").trim() || null,
    });
  }
  if (!rows.length && !errors.length) errors.push("The file has a header and no rows.");
  return { rows: errors.length ? [] : rows, errors };
}

/* ── SPOTS PER HOUR, THE UNIT THAT MAKES THE QUALITY CHECK HONEST ─────────────────────────────
 * Spots per MATCH called Memorial Indoor a 3.5x outlier: 35 spots in a 5v5 against an implied 10.
 * It is a 180-minute open play, which is 11.7 an hour against the same implied 10. The capture was
 * never wrong; the unit was.
 *
 * NULL WHERE THE DURATION IS UNKNOWN, which is every GoodRec row by construction. A per-hour figure
 * for a slot of unknown length is not a worse number, it is not a number. */
export function spotsPerHour(spots: number, durationMinutes: number | null): number | null {
  if (durationMinutes == null || !(durationMinutes > 0)) return null;
  return (spots / durationMinutes) * 60;
}

/** What one hour of this format implies: 7v7 is 14 players on the pitch. */
export const impliedSpotsPerHour = (format: string): number | null => {
  const n = formatSize(format);
  return Number.isFinite(n) ? 2 * n : null;
};

/**
 * Is this listing's supply out of line with its format, per hour?
 *
 * Returns null when it cannot be judged rather than guessing: no duration means no per-hour figure,
 * and a check that silently falls back to per-match is the one that produced the wrong answer.
 */
export function listingOutlierRatio(
  spots: number, durationMinutes: number | null, format: string,
): number | null {
  const per = spotsPerHour(spots, durationMinutes);
  const implied = impliedSpotsPerHour(format);
  if (per == null || implied == null || implied <= 0) return null;
  return per / implied;
}
