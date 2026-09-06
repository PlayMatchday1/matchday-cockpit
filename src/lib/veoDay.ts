/* THE VEO DAY — one day of camera matches, and what happened to each one's film.
 *
 * WHY THE STATE IS A PURE FUNCTION OVER (match, recordings, code). The page's tally strip is also
 * its filter, so the five counts must partition the day exactly: a match in the total and in none
 * of the five is a row you cannot reach by clicking, and a match in two of them makes the strip
 * add to more than the day. Both are invisible on screen — the numbers look like numbers. The
 * identity is asserted in scripts/veo-day-test.ts over generated combinations, which is only
 * possible because nothing here touches a database.
 *
 * THE FIVE ARE ORDERED, AND THE ORDER IS THE DEFINITION:
 *
 *   posted        a recording posted ITSELF to this match, on a read with nothing inferred
 *   flagged       a recording posted itself, and something about the title was a guess
 *   assigned      a PERSON put it there — posted_by_user_id is set
 *   held          the match's code is queue-only (confirmed: false) — deliberately not posted,
 *                 which is why it outranks "needs a look": there is nothing wrong here
 *   needs_look    a recording arrived, names this match, and did not post
 *   no_film       nothing has arrived
 *
 * `flagged` is NOT a status in the database. It is a boolean on a posted row, so a flagged post
 * must be counted under flagged and NOT ALSO under posted, or the strip stops adding up.
 *
 * NEITHER IS "assigned", AND IT IS THE MORE IMPORTANT SPLIT. The assign route stamps
 * posted_by_user_id, and mixing those rows into status = 'posted' is exactly what made "posted
 * went 16 to 15" unreadable: seven of the sixteen were hand-assignments, so the automatic baseline
 * was 9 and looked like 16. Anyone measuring the matcher off this page has to be able to see the
 * number the matcher actually produced.
 */

export type FilmState = "posted" | "flagged" | "assigned" | "held" | "needs_look" | "no_film";

export const FILM_STATE_LABEL: Record<FilmState, string> = {
  posted: "Posted",
  flagged: "Posted, flagged",
  assigned: "Assigned by hand",
  held: "Held",
  needs_look: "Needs a look",
  no_film: "No film yet",
};

/** Rendering order for the tally strip, left to right. */
export const FILM_STATES: readonly FilmState[] = ["posted", "flagged", "assigned", "held", "needs_look", "no_film"];

export type VeoDayRecording = {
  id: string;
  recordingId: string;
  subject: string | null;
  videoUrl: string | null;
  receivedAt: string | null;
  status: "posted" | "queued" | "dismissed";
  queueReason: string | null;
  matchedApiId: number | null;
  candidateApiIds: number[];
  /** Null on every row written before scoring existed — a number was never computed for it. */
  score: number | null;
  scoreParts: VeoScoreParts | null;
  flagged: boolean;
  parsedCode: string | null;
  parsedMatchDate: string | null;
  parsedTimeLabel: string | null;
  /** Minutes past local midnight, for printing the gap to each assign candidate. */
  parsedTimeMinutes: number | null;
  /** Set when a PERSON assigned it. Null on an automatic post — the distinction the tally needs. */
  postedByUserId: string | null;
};

/** The shape veo.ts writes into score_parts. Read, never recomputed. */
export type VeoScoreParts = {
  total: number;
  band: string;
  code: number; codeTier: string;
  date: number; dateForm: string | null;
  time: number; timeForm: string | null;
  field: number; fieldAgrees: boolean;
};

/* WHERE AN UNPLACED RECORDING ACTUALLY WENT. A recording can be posted to a real match that this
 * page does not list, because the page lists only matches on a field some veo_codes row names. That
 * is not a bug in either — it is a gap in the code table, and saying so is more useful than a row
 * labelled "could not place". Measured on 2026-07-31: two Pearland recordings were hand-assigned to
 * matches on field 22, and ATHP's field_ids is [32]. */
export type UnplacedTarget = { apiId: number; name: string; fieldId: number | null; date: string | null };

export type VeoDayMatch = {
  apiId: number;
  name: string;
  city: string;
  cityCode: string;
  venue: string;
  fieldId: number;
  /** The veo_codes code whose field_ids contain this match's field. Never null — a row only exists
   *  on this page because some code names its field. */
  code: string;
  codeConfirmed: boolean;
  date: string;
  time: string;
  minutes: number;
  players: number | null;
  capacity: number | null;
  cancelled: boolean;
};

export type VeoDayRow = VeoDayMatch & {
  state: FilmState;
  recordings: VeoDayRecording[];
  /** The recording that decides the state — the posted one, else the first attached. */
  primary: VeoDayRecording | null;
};

/* ── ATTACHING A RECORDING TO A MATCH ──────────────────────────────────────────────────────────
 * matched_api_id is the strong link (a post, or a post_failed carrying the id it chose). A queued
 * recording that could not be narrowed carries candidate_api_ids instead, and those may name
 * SEVERAL matches on the day — that is what multiple_matches means. Each of those matches then
 * reads "needs a look", which is correct: a reviewer has to decide between them. The tally still
 * adds up because it counts MATCHES, and every match has exactly one state. */
export function attachedTo(apiId: number, recs: readonly VeoDayRecording[]): VeoDayRecording[] {
  return recs.filter((r) => r.matchedApiId === apiId || r.candidateApiIds.includes(apiId));
}

export function filmState(match: Pick<VeoDayMatch, "apiId" | "codeConfirmed">, recs: readonly VeoDayRecording[]): FilmState {
  const mine = attachedTo(match.apiId, recs);
  const posted = mine.find((r) => r.status === "posted" && r.matchedApiId === match.apiId);
  if (posted) {
    if (posted.postedByUserId) return "assigned";
    return posted.flagged ? "flagged" : "posted";
  }
  // Deliberate, and it outranks needs_look: a queue-only code is working as configured.
  if (!match.codeConfirmed) return "held";
  if (mine.some((r) => r.status !== "dismissed")) return "needs_look";
  return "no_film";
}

export function buildDayRows(matches: readonly VeoDayMatch[], recs: readonly VeoDayRecording[]): VeoDayRow[] {
  return matches.map((m) => {
    const mine = attachedTo(m.apiId, recs);
    const state = filmState(m, recs);
    /* WHICH RECORDING THIS ROW IS ABOUT, when more than one attaches to it. A posted one is the
     * answer outright. Otherwise take the recording whose OWN parsed time is nearest this match.
     *
     * The Pearland Friday pair is why. Both recordings carry candidate_api_ids [9:15, 8:15], so
     * both attach to both rows, and taking mine[0] put the 9:15 recording under the 8:15 match —
     * the panel then marked the 9:15 candidate "exact" on a row headed 8:15 PM, which is the exact
     * confusion an operator assigning by hand must not be handed. */
    const posted = mine.find((r) => r.status === "posted" && r.matchedApiId === m.apiId);
    const nearest = [...mine].sort((a, b) => {
      const da = a.parsedTimeMinutes == null ? Number.POSITIVE_INFINITY : Math.abs(a.parsedTimeMinutes - m.minutes);
      const db = b.parsedTimeMinutes == null ? Number.POSITIVE_INFINITY : Math.abs(b.parsedTimeMinutes - m.minutes);
      return da - db;
    })[0];
    return { ...m, state, recordings: mine, primary: posted ?? nearest ?? null };
  });
}

export type VeoDayTally = Record<FilmState, number> & { total: number };

export const emptyTally = (total: number): VeoDayTally =>
  ({ posted: 0, flagged: 0, assigned: 0, held: 0, needs_look: 0, no_film: 0, total });

export function tally(rows: readonly VeoDayRow[]): VeoDayTally {
  const t = emptyTally(rows.length);
  for (const r of rows) t[r.state] += 1;
  return t;
}

/** THE IDENTITY THE STRIP DEPENDS ON. Exported so the page and the suite ask the same question. */
export function tallyAddsUp(t: VeoDayTally): boolean {
  return FILM_STATES.reduce((a, k) => a + t[k], 0) === t.total;
}

/* ── AN ASSIGN CANDIDATE ───────────────────────────────────────────────────────────────────────
 * What an operator needs to pick a match without leaving the page: when it starts, what it is,
 * where, how full, and HOW FAR IT IS FROM THE TIME IN THE TITLE — written out, not left as
 * arithmetic. "exact" against "60 min later" is the entire Pearland decision.
 *
 * `coded` is false when no veo_codes row names the match's field. Such a candidate is still
 * offered and still assignable: a person assigning by hand IS the deliberate override, and refusing
 * it would defeat the point of an escape hatch. It is labelled so the override is informed. */
export type AssignCandidate = {
  apiId: number;
  name: string;
  venue: string;
  city: string;
  time: string;
  minutes: number;
  players: number | null;
  capacity: number | null;
  fieldId: number | null;
  coded: boolean;
};

/** The gap, in the words a person uses. Null when there is no parsed time to compare against. */
export function gapLabel(candidateMinutes: number, titleMinutes: number | null): string | null {
  if (titleMinutes == null) return null;
  const d = candidateMinutes - titleMinutes;
  if (d === 0) return "exact";
  const n = Math.abs(d);
  const unit = n === 1 ? "min" : "min";
  return `${n} ${unit} ${d > 0 ? "later" : "earlier"}`;
}

/* ── THE SCORE TRACE ───────────────────────────────────────────────────────────────────────────
 * Built from score_parts on the row and nothing else. The page must never re-parse a subject to
 * explain a decision that was already made: a trace derived a second time can disagree with its
 * own total, and the hand-written version of this was out by 32 points.
 *
 * Returns null for a row written before scoring existed. A null score is an ABSENCE and the page
 * shows no number — printing 0 / 100 for it would read as a confident zero. */
export type TraceLine = { label: string; detail: string; points: number };

export function scoreTrace(parts: VeoScoreParts | null): TraceLine[] | null {
  if (!parts) return null;
  return [
    { label: "Code", detail: `${parts.codeTier} match`, points: parts.code },
    { label: "Date", detail: parts.dateForm ? `${parts.dateForm} form` : "not read", points: parts.date },
    { label: "Time", detail: parts.timeForm ? `${parts.timeForm} form` : "not read", points: parts.time },
    { label: "Field", detail: parts.fieldAgrees ? "agrees with the code" : "no agreement", points: parts.field },
  ];
}

/** The trace must add to the number stored on the row. Asserted, not hoped for. */
export function traceSum(lines: readonly TraceLine[]): number {
  return lines.reduce((a, l) => a + l.points, 0);
}
