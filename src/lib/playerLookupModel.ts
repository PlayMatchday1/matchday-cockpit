// Player Lookup (Phase 18) — the pure, testable core: what did the operator type,
// and where should a new player go. No React, no fetch — so scripts/player-lookup-
// model-test.ts can pin the detection and the add-suggestion without a browser.
//
// ── THE CLAIM THIS FILE SHIPPED WITH, AND WHY IT WAS WRONG ────────────────────────────────────
//
// It read, verbatim:
//
//     Search detection mirrors the real API: /admin/players?email=<term> is a UNIVERSAL
//     fuzzy match (it hits email, name AND phone-digits — confirmed live), and ?id=<n>
//     is exact. So the KIND we detect drives the HINT and whether a single hit goes
//     straight through; the server turns everything except a pure id into ?email.
//
// CORRECTION (2026-08-26). `?email=` matches EMAIL and PHONE. **It does not match name.**
// Measured over four terms on production — anderson (18 hits), smith (29), maria (37), king (69):
// every single one of those 153 hits has the term inside its EMAIL, and there are ZERO name-only
// hits. The 12 of 18 "anderson" results whose NAME contains it are coincidence — their email does
// too, which is what made "confirmed live" look confirmed.
//
// The account that exposed it: Anderson King, id 395, email kinga11592@gmail.com. His email holds
// "king" and not "anderson", so searching "anderson" could never reach him while searching "king"
// always did. A COMMENT ASSERTING SOMETHING NOBODY TESTED IS WHAT LET THIS SURVIVE; the assertion
// that would have caught it — a player whose NAME contains the term and whose EMAIL does not — did
// not exist until player-lookup-model-test.ts got one.
//
// Two consequences followed from the same root:
//   · a two-word query was ONE substring against the email. Emails have no spaces, so
//     "anderson king", "john smith", "maria garcia" and "de la" all returned exactly zero, always.
//   · the API exposes NO name parameter at all, so this is not fixable by changing a query string.
//
// WHAT HAPPENS NOW. A `name` term is answered from OUR MIRROR (mdapi_users, first_name/last_name,
// one ilike predicate per whitespace-separated word), and the mirror is used ONLY to find candidate
// IDs — every row shown is then fetched LIVE from the API by id, so the detail is as fresh as it
// has always been. `?id=` is still exact; email and phone still go to `?email=`, which is what that
// parameter genuinely does.

export type SearchKind = "empty" | "email" | "phone" | "id" | "name";

export type Detected = { kind: SearchKind; norm: string };

// A bare 1-6 digit number is far more likely a player ID than a phone; 7+ digits is
// a phone (digits only, so formatting never matters). An @ is unambiguously an email.
export function detectKind(raw: string): Detected {
  const q = (raw ?? "").trim();
  if (!q) return { kind: "empty", norm: "" };
  if (q.includes("@")) return { kind: "email", norm: q.toLowerCase() };
  const digits = q.replace(/[^\d]/g, "");
  if (/^\d{1,6}$/.test(q)) return { kind: "id", norm: q };
  if (digits.length >= 7) return { kind: "phone", norm: digits };
  return { kind: "name", norm: q.toLowerCase() };
}

export const SEARCH_HINT: Record<SearchKind, string> = {
  empty: "Type anything — it works out whether you gave it a phone number, an email, an ID or a name.",
  email: "Reading that as an email address.",
  phone: "Reading that as a phone number — digits only, so formatting does not matter.",
  id: "Reading that as a player ID. Add a country code or dashes if you meant a phone number.",
  name: "Reading that as a name.",
};

/* The query the server should send for a detected term.
 *
 * IT USED TO END `return { email: d.norm }` FOR EVERYTHING, INCLUDING A NAME — which is the bug.
 * A name has no upstream parameter to go to, so it is not in this function's remit at all now:
 * callers ask `usesMirror(kind)` first and only reach here for the kinds the API can answer.
 * Calling it with a name throws rather than silently rebuilding the old behaviour. */
export function serverQuery(d: Detected): Record<string, string> {
  if (d.kind === "id") return { id: d.norm };
  if (d.kind === "phone") return { email: d.norm };
  if (d.kind === "email") return { email: d.norm };
  throw new Error(`serverQuery: ${d.kind} is not an upstream-answerable kind — see usesMirror()`);
}

/** A name cannot be asked of the API. Everything else can. */
export const usesMirror = (kind: SearchKind): boolean => kind === "name";

/* ── SPLIT ON WHITESPACE ───────────────────────────────────────────────────────────────────────
 * "anderson king" becomes TWO predicates, each of which must match first_name or last_name. As one
 * substring it was impossible — no name field and no email contains "anderson king" — which is why
 * every two-word query in the app returned zero.
 *
 * Order-independent by construction: "king anderson" produces the same two predicates, so it finds
 * him too. Duplicates are collapsed so "john john" is not two identical scans. */
export function splitNameTerms(raw: string): string[] {
  return [...new Set((raw ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

/* ── ONE DEFINITION OF "MATCHES A NAME", IN TWO FORMS ─────────────────────────────────────────
 * `matchesNameTerms` is the SPEC — what the operator is promised. `nameOrFilter` is the PostgREST
 * expression the route actually sends. They are written next to each other and asserted to agree,
 * because a spec in one file and a query string in another is how the behaviour drifts.
 *
 * A term matches if it appears in first_name OR last_name (case-insensitive substring). EVERY term
 * must match — so "anderson king" needs both, and "king anderson" is the same two predicates. */
export function matchesNameTerms(first: string | null | undefined, last: string | null | undefined, terms: readonly string[]): boolean {
  const f = String(first ?? "").toLowerCase(), l = String(last ?? "").toLowerCase();
  return terms.length > 0 && terms.every((t) => f.includes(t) || l.includes(t));
}

/* PostgREST's or() is COMMA-DELIMITED, so a comma or a paren inside a term would change the shape
 * of the filter rather than be searched for. They are stripped, not escaped — a name containing one
 * is not a thing anyone is searching for, and a mangled filter is worse than a narrower one. */
export const sanitizeNameTerm = (t: string): string => t.replace(/[%,()\\]/g, "");

export function nameOrFilter(term: string): string | null {
  const t = sanitizeNameTerm(term);
  return t ? `first_name.ilike.%${t}%,last_name.ilike.%${t}%` : null;
}

/* ── THE PAGE, AND THE NUMBER THE HEADER IS ALLOWED TO SAY ─────────────────────────────────────
 * `limit: 15, page: 1` was hardcoded in the route and the header called the 15 rows it got back
 * "15 matches". Every one of fifteen common terms has more than 15: king 69, john 122, jose 299,
 * ana 396. So the header was false on all of them, and because the API orders by firstName
 * ascending, the rows it silently dropped were always the END OF THE ALPHABET — for "anderson",
 * three Wandersons.
 *
 * The API returns `totalItems` on every response and the route never read it. It does now. */
export const SEARCH_PAGE_SIZE = 25;

export type SearchTotal =
  | { known: true; total: number }
  /* THE MIRROR PATH KNOWS ITS TOTAL EXACTLY (a counted query), so this variant exists for a
   * different case: a total we did not get back. Print "showing N" and nothing else rather than a
   * number that is not one. */
  | { known: false };

export function resultHeader(shown: number, t: SearchTotal, page = 1, pageSize = SEARCH_PAGE_SIZE): string {
  if (shown === 0) return "No matches";
  if (!t.known) return `Showing ${shown}${shown === 1 ? " match" : " matches"} — the total is not known`;
  if (t.total <= shown && page === 1) return `${t.total} ${t.total === 1 ? "match" : "matches"}`;
  const from = (page - 1) * pageSize + 1;
  return `Showing ${from}–${from + shown - 1} of ${t.total}`;
}

export const pageCount = (total: number, pageSize = SEARCH_PAGE_SIZE): number =>
  Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

// ---- strikes (MEMBERS ONLY) -------------------------------------------------
// 4 active strikes ⇒ a 1-week suspension. activeStrikes is server-computed (a SUM of
// penaltyPoints, so a single strike can weigh >1) — display it, never recompute it.
export const STRIKE_LIMIT = 4;

// The strike reason is the user-match `userStatus` enum (NOT cancelledBefore24Hours,
// which is the 24h REFUND flag for pay-per-match players). Only these three values name
// an actual reason.
const STRIKE_REASON: Record<string, string> = {
  LATE: "LATE",
  NO_SHOW: "NO SHOW",
  CANCEL_W_IN_SOME_HOURS: "LATE CANCEL",
};
// userStatus "NONE"/"ON_TIME" (31 of 188 rows were NONE) are NOT reasons — they must
// not be rendered as a label. A strike whose user-match carries one, or whose user-match
// isn't in the list, says THAT a strike exists ("STRIKE"), never a made-up why.
export function isKnownStrikeReason(userStatus: string | null | undefined): boolean {
  return userStatus != null && userStatus in STRIKE_REASON;
}
export function strikeReasonLabel(userStatus: string | null | undefined): string {
  return isKnownStrikeReason(userStatus) ? STRIKE_REASON[userStatus as string] : "STRIKE";
}

export function money(cents: number | null | undefined): string {
  const c = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return "$" + (c / 100).toFixed(2);
}

// ---- add-to-match spot suggestion -------------------------------------------
// A team is {size, taken:number[]}. Open spots are 1..size minus taken.
export type SpotTeam = { size: number; taken: number[] };

export function openSpots(t: SpotTeam): number[] {
  const taken = new Set(t.taken ?? []);
  const out: number[] = [];
  for (let n = 1; n <= (t.size ?? 0); n++) if (!taken.has(n)) out.push(n);
  return out;
}

export function matchOpen(teams: SpotTeam[]): number {
  return (teams ?? []).reduce((n, t) => n + openSpots(t).length, 0);
}

// Suggest the EMPTIER side, then its lowest free number. Balancing sides matters more
// than filling the first gap — an 8v2 is a worse match than a 6v4, so balance before
// fill. Returns null when the match is full.
export function suggestSpot(teams: SpotTeam[]): { team: number; spot: number } | null {
  const cands = (teams ?? [])
    .map((t, i) => ({ i, taken: (t.taken ?? []).length, free: openSpots(t) }))
    .filter((x) => x.free.length > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => a.taken - b.taken || a.i - b.i);
  return { team: cands[0].i, spot: cands[0].free[0] };
}
