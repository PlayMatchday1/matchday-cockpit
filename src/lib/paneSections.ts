/* THE CONTEXT PANE'S SUMMARIES AND ITS SEARCH REASONS — the parts that must be derived, not written.
 *
 * EVERY SECTION HEADER CARRIES ITS OWN ANSWER, so a shut section still tells you something. That is
 * only true if the summary is computed FROM the section's own data: a header written separately
 * from the rows under it is a caption, and a caption goes stale the first time the data moves.
 * Every function here takes exactly the data its section renders and nothing else.
 *
 * COLOUR IS RATIONED. `tone` is "plain" unless there is a reason: amber for something worth a look,
 * red only for something wrong. A player with three failed charges reads red; a player with nothing
 * wrong has no red anywhere on the pane.
 */

export type Tone = "plain" | "amber" | "red";
export type Summary = { text: string; tone: Tone };

export const SECTION_IDS = ["credits", "matches", "membership", "payments", "strikes", "account"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_LABEL: Record<SectionId, string> = {
  credits: "Credits",
  matches: "Match history",
  membership: "Membership",
  payments: "Payments",
  strikes: "Strikes",
  account: "Account history",
};

const usd = (cents: number | null | undefined): string =>
  "$" + ((typeof cents === "number" && Number.isFinite(cents) ? cents : 0) / 100).toFixed(2);

/* SECTION STATE IS A PREFERENCE, NOT DATA. It is keyed on the OPERATOR, never on the thread: the
 * whole point is that opening Payments once during a run of billing questions leaves it open on the
 * next conversation. Keyed per operator so two people sharing a browser profile do not inherit each
 * other's pane. */
export const sectionStorageKey = (operatorId: string | null): string =>
  `crm:pane:sections:${operatorId ?? "anon"}`;

export const DEFAULT_OPEN: Record<SectionId, boolean> = {
  credits: false, matches: false, membership: false, payments: false, strikes: false, account: false,
};

export function readSectionState(raw: string | null): Record<SectionId, boolean> {
  if (!raw) return { ...DEFAULT_OPEN };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_OPEN };
    for (const id of SECTION_IDS) if (typeof parsed[id] === "boolean") out[id] = parsed[id] as boolean;
    return out;
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

// ---------------------------------------------------------------------------
// The summaries, each over its own section's data
// ---------------------------------------------------------------------------

export const creditsSummary = (cents: number | null): Summary =>
  ({ text: usd(cents), tone: "plain" });

export type MatchLike = { state: "upcoming" | "played" | "cancelled" };

export function matchesSummary(matches: readonly MatchLike[]): Summary {
  const played = matches.filter((m) => m.state === "played").length;
  const upcoming = matches.filter((m) => m.state === "upcoming").length;
  const cancelled = matches.filter((m) => m.state === "cancelled").length;
  const parts: string[] = [];
  if (played) parts.push(`${played} played`);
  if (upcoming) parts.push(`${upcoming} upcoming`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  if (!parts.length) return { text: "None on record", tone: "plain" };
  return { text: parts.join(" · "), tone: "plain" };
}

export type MembershipLike = { status: string; canceledAt: string | null; renews: string | null } | null;

/** currentPeriodEnd is a boundary (…T04:59:59Z = the last second of the month in Central), so it
 *  prints in UTC — the date the API and Stripe both name. canceledAt is a true instant and prints
 *  in Central. The membership card on Player Lookup makes exactly the same split. */
const dayUTC = (iso: string | null) => iso && Number.isFinite(Date.parse(iso))
  ? new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
const dayCT = (iso: string | null) => iso && Number.isFinite(Date.parse(iso))
  ? new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }) : null;

export function membershipSummary(m: MembershipLike, nowMs = Date.now()): Summary {
  if (!m) return { text: "Not a member", tone: "plain" };
  if (m.canceledAt) {
    const runsTo = m.renews && Date.parse(m.renews) > nowMs ? dayUTC(m.renews) : null;
    // AMBER, NOT RED. A cancellation is worth a look; nothing is wrong with the account.
    return { text: runsTo ? `Cancelled ${dayCT(m.canceledAt)}, runs to ${runsTo}` : `Cancelled ${dayCT(m.canceledAt)}`, tone: "amber" };
  }
  const st = (m.status || "").toLowerCase();
  if (st.includes("past") || st.includes("due") || st.includes("unpaid")) return { text: "Past due", tone: "red" };
  return { text: m.renews ? `Member · renews ${dayUTC(m.renews)}` : "Member", tone: "plain" };
}

export type PaymentLike = { status: string; amount: number; isMembership: boolean };

export function paymentsSummary(rows: readonly PaymentLike[] | null, error?: string | null): Summary {
  if (error) return { text: "Could not read Stripe", tone: "amber" };
  if (!rows || rows.length === 0) return { text: "Nothing on file", tone: "plain" };
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const failed = n("failed"), disputed = n("disputed"), refunded = n("refunded"), paid = n("succeeded");
  const parts: string[] = [];
  if (paid) parts.push(`${paid} paid`);
  if (refunded) parts.push(`${refunded} refunded`);
  if (failed) parts.push(`${failed} failed`);
  if (disputed) parts.push(`${disputed} disputed`);
  // RED ONLY FOR SOMETHING WRONG. A failed or disputed charge is money that did not work.
  const tone: Tone = failed || disputed ? "red" : refunded ? "amber" : "plain";
  return { text: parts.join(" · "), tone };
}

export type StrikeLike = { activeCount: number; limit: number; isSuspended: boolean } | null;

export function strikesSummary(s: StrikeLike): Summary {
  if (!s) return { text: "None", tone: "plain" };
  if (s.isSuspended) return { text: `Suspended · ${s.activeCount} of ${s.limit}`, tone: "red" };
  const tone: Tone = s.activeCount >= s.limit ? "red" : s.activeCount > 0 ? "amber" : "plain";
  return { text: `${s.activeCount} of ${s.limit}`, tone };
}

export type AccountEvent = { action: "suspend" | "expel"; until: string | null };

export function accountSummary(status: "ok" | "suspended" | "expelled", events: readonly AccountEvent[]): Summary {
  if (status === "expelled") return { text: "Expelled", tone: "red" };
  if (status === "suspended") return { text: "Suspended", tone: "red" };
  if (events.length) return { text: `${events.length} past action${events.length === 1 ? "" : "s"}`, tone: "amber" };
  return { text: "Clean record", tone: "plain" };
}

/* ── WHY A SEARCH RESULT MATCHED ───────────────────────────────────────────────────────────────
 * A list of names with no reason is a guess dressed as a recommendation. The operator is deciding
 * whether the number a player just read out is really theirs, and "this row matched the last seven
 * digits" and "this row matched the name you typed" are different levels of evidence.
 *
 * Derived from the row and the query rather than reported by the search route, because the route
 * answers at the PAYLOAD level ("api" or "mirror") and the question here is per result. */
export type SearchLike = { id: number; name: string; email: string | null; phone: string | null };
export type MatchReason = "id" | "phone" | "last7" | "email" | "name" | "unclear";

export const REASON_LABEL: Record<MatchReason, string> = {
  id: "player ID",
  phone: "full phone",
  last7: "last 7 digits",
  email: "email",
  name: "name",
  unclear: "matched",
};

const digits = (s: string) => s.replace(/\D/g, "");

export function matchReason(query: string, row: SearchLike): MatchReason {
  const q = query.trim().toLowerCase();
  if (!q) return "unclear";
  if (/^\d+$/.test(q) && String(row.id) === q) return "id";
  const qd = digits(q);
  const rd = digits(row.phone ?? "");
  if (qd.length >= 7 && rd) {
    if (rd === qd || rd.endsWith(qd) && qd.length >= 10) return "phone";
    if (rd.slice(-7) === qd.slice(-7)) return "last7";
  }
  if (q.includes("@") && (row.email ?? "").toLowerCase().includes(q)) return "email";
  const nm = row.name.toLowerCase();
  if (q.split(/\s+/).every((w) => w.length > 1 && nm.includes(w))) return "name";
  if ((row.email ?? "").toLowerCase().includes(q)) return "email";
  return "unclear";
}
