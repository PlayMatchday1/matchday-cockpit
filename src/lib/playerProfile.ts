import "server-only";

/* THE PLAYER PROFILE, IN ONE PLACE.
 *
 * This mapping lived inline in /api/lookup/[env]. The Player Chats context pane now shows the same
 * player — credits, membership, strikes, match history, account history — and Ryan's ask was that
 * the pane show "all the player data from player look up so you dont have to go to player look up".
 * Two copies of this mapping would drift, and the failure would be silent: a pane and a page
 * quoting different credit balances during a billing argument, with no error anywhere.
 *
 * So it was MOVED here rather than rewritten, and both callers use it. It is pure over the two
 * MatchDay payloads it is handed, except for one callback: resolving the name of the admin who
 * issued a ban needs a second API call, which the caller supplies.
 */

import type { MatchdayEnv } from "@/lib/matchdayStageApi";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const name = (r: Record<string, unknown>) => [str(r.firstName), str(r.lastName)].filter(Boolean).join(" ").trim() || `User ${r.id}`;

// Ban status: permanent ban = EXPELLED; timed/active ban = SUSPENDED; else OK.
function banStatus(r: Record<string, unknown>): "expelled" | "suspended" | "ok" {
  if (r.isBanPermanent === true) return "expelled";
  if (r.isBanned === true) return "suspended";
  return "ok";
}

function activeSub(subs: unknown): Record<string, unknown> | null {
  if (!Array.isArray(subs) || !subs.length) return null;
  // prefer a non-cancelled subscription, else the most recent row
  const rows = subs as Record<string, unknown>[];
  const live = rows.find((s) => !s.canceledAt && (s.status == null || String(s.status).toLowerCase() !== "canceled"));
  return live ?? rows[0];
}

export type PlayerProfile = Awaited<ReturnType<typeof buildProfile>>;
export type ProfileMatch = PlayerProfile["matches"][number];

export async function buildProfile(args: {
  raw: unknown;
  listRow: Record<string, unknown> | null;
  /** Resolve the display name of the admin who issued a ban. One extra API call, caller-owned. */
  resolveActor: (userId: number) => Promise<string | null>;
}) {
  const { raw, listRow, resolveActor } = args;
  const d: Record<string, unknown> =
    ((raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw) as Record<string, unknown>) ?? {};
  const now = Date.now();

  const matchesRaw = Array.isArray(d.matches) ? (d.matches as Record<string, unknown>[]) : [];
  const matches = matchesRaw.map((um) => {
    const m = (um.match as Record<string, unknown>) ?? {};
    // DELIBERATELY NOT rosterRowCounts(). This is one PLAYER'S history, not a roster count:
    // the question here is "did this participation get cancelled", and an unsettled checkout
    // (paidStatus "WAITING") is a real thing that happened to this player and should stay
    // visible in their history. rosterRowCounts answers "does this row occupy a spot", which is
    // a different question — see docs/matchday-api-facts.md, the roster population.
    const cancelled = um.isCancelled === true || m.isCancelled === true;
    const startUtc = str(m.startDateUtc) ?? str(m.startDate);
    const upcoming = !cancelled && !!startUtc && Date.parse(startUtc) > now;
    return {
      umId: num(um.id), matchId: num(um.matchId ?? m.id), name: str(m.name) ?? `Match ${num(m.id)}`,
      startDate: str(m.startDate), startDateUtc: startUtc,
      team: num(um.team), num: num(um.playerNumber),
      price: num(um.amount) ?? num(m.registrationPrice) ?? 0,   // base spot price
      charged: num(um.totalAmount),                              // what Stripe actually took (base + card fee − credit); may differ from price
      userStatus: str(um.userStatus),                            // attendance/reason enum (NO_SHOW etc.)
      state: cancelled ? "cancelled" : upcoming ? "upcoming" : "played",
      removable: upcoming, // only a future booking can be pulled
    };
  }).sort((a, b) => (Date.parse(b.startDateUtc ?? "") || 0) - (Date.parse(a.startDateUtc ?? "") || 0));

  // Strikes — MEMBERS-ONLY penalty. The server pre-computes activeStrikes; we join
  // each strikeLog to its user-match to recover the REASON (userStatus) and, for a
  // cancellation, the timing (canceledAt vs kickoff). A log whose user-match is not
  // in matches[] keeps its penalty but shows no reason (THAT a strike exists, not WHY).
  const s = (d.strike as Record<string, unknown> | undefined) ?? {};
  const umInfo = new Map<number, Record<string, unknown>>();
  for (const um of matchesRaw) { const uid = num(um.id); if (uid != null) umInfo.set(uid, um); }
  const logsRaw = Array.isArray(s.strikeLogs) ? (s.strikeLogs as Record<string, unknown>[]) : [];
  const strikeLogs = logsRaw.map((l) => {
    const um = umInfo.get(num(l.userMatchId) ?? -1);
    const m = (um?.match as Record<string, unknown>) ?? {};
    const kickoff = str(m.startDateUtc) ?? str(m.startDate);
    const canceledAt = um ? str(um.canceledAt) : null;
    const hoursBefore = canceledAt && kickoff && Number.isFinite(Date.parse(canceledAt)) && Number.isFinite(Date.parse(kickoff))
      ? Math.round(((Date.parse(kickoff) - Date.parse(canceledAt)) / 3600e3) * 10) / 10 : null;
    return {
      penaltyPoint: num(l.penaltyPoint) ?? 1, active: l.active === true,
      reason: um ? str(um.userStatus) : null,
      matchName: str(m.name), when: str(m.startDate) ?? kickoff,
      issued: str(l.createdAt), canceledAt, hoursBefore,
    };
  }).sort((a, b) => (Date.parse(b.issued ?? "") || 0) - (Date.parse(a.issued ?? "") || 0));
  const strikes = {
    activeCount: num(s.activeStrikes) ?? 0, limit: 4,
    isSuspended: s.isSuspended === true, suspendedTo: str(s.suspendedTo),
    expiredAt: str(s.expiredAt), firstStrikeAt: str(s.firstStrikeAt),
    logs: strikeLogs,
  };

  // Account history: the API exposes the CURRENT ban record, not a full audit trail
  // (there is no per-player ban-history endpoint). One row when banned — action from
  // isBanPermanent, who resolved from bannedByUserId. Our OWN future actions land in
  // the Change Log with the actor; note that in the UI so absence isn't read as clean.
  const accountHistory: { action: "suspend" | "expel"; reason: string | null; when: string | null; until: string | null; by: string | null }[] = [];
  if (d.isBanned === true) {
    const byId = num(d.bannedByUserId);
    // The one call this mapping cannot make itself — the caller owns the API client.
    const by: string | null = byId != null ? ((await resolveActor(byId)) ?? `user ${byId}`) : null;
    accountHistory.push({
      action: d.isBanPermanent === true ? "expel" : "suspend",
      reason: str(d.banReason), when: str(d.bannedAt),
      until: d.isBanPermanent === true ? null : str(d.banExpiredAt), by,
    });
  }

  const sub = activeSub(d.userSubscriptions);
  // Defensive mapping — the exact userSubscriptions shape for active members is
  // unconfirmed live; render only fields that are present, never "undefined".
  const membership = sub ? {
    status: str(sub.status) ?? (sub.canceledAt ? "canceled" : "active"),
    number: str(sub.stripeSubscriptionId) ?? str(sub.id),
    since: str(sub.activationDate) ?? str(sub.createdAt) ?? str(sub.currentPeriodStart),
    renews: str(sub.currentPeriodEnd),
    canceledAt: str(sub.canceledAt),
    price: num(sub.amount),
    city: str(sub.cityIdentifier),
  } : null;
  return {
    player: {
      id: num(d.id), name: name(d), email: str(d.email), phone: str(d.phoneNumber),
      phoneVerified: d.phoneNumberVerifiedAt != null,
      // preferableCity lives on the LIST row, not detail — read it from there (fall back
      // to detail in case the API changes), else null.
      city: str(((listRow?.preferableCity ?? d.preferableCity) as Record<string, unknown> | undefined)?.name),
      level: num(d.selfRatingValue),
      registered: str(d.completedSignUpAt) ?? str(d.createdAt),
      goals: Array.isArray(d.goals) ? d.goals.length : 0,
      cityManager: Array.isArray(d.cityManagers) && d.cityManagers.length > 0,
      credits: num(d.creditAmount) ?? 0,
      status: banStatus(d),
      banReason: str(d.banReason),
      bannedAt: str(d.bannedAt),
      banExpiredAt: str(d.banExpiredAt),
      matchesPlayed: matches.filter((m) => m.state === "played").length,
      upcoming: matches.filter((m) => m.state === "upcoming").length,
    },
    membership,
    matches,
    strikes,
    accountHistory,
  };
}

/** The two MatchDay reads a profile needs, in parallel. `env` picks staging or production. */
export type ProfileEnv = MatchdayEnv;
