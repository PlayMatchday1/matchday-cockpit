// Player Lookup read route (Phase 18) — READ-ONLY. Two shapes:
//   GET ?q=<term>  -> search. Universal fuzzy: /admin/players?email=<term> matches
//                     email, name AND phone-digits (confirmed live); a pure id uses
//                     ?id=<n> (exact). Returns a light row per hit — no strikes, no
//                     payments, no card data.
//   GET ?id=<n>    -> one profile: identity, facts, membership, match history and the
//                     read-only STRIKES summary (server-computed activeStrikes + per-log
//                     reason joined from the user-match's userStatus). PAYMENTS and
//                     ACCOUNT-HISTORY are still NOT built — this route never returns Stripe
//                     charge or ban-history data, so those empty panels can't lie.
//
// Writes (add to / remove from a match) do NOT live here — they reuse the existing
// guarded roster route (/api/matchday/{env}/roster/{matchId}) so there is ONE write
// path with the EDIT MATCHES gate, deny-lists and recordWrite already on it.

import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { detectKind, serverQuery } from "@/lib/playerLookupModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
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

function lightRow(r: Record<string, unknown>) {
  const city = (r.preferableCity as Record<string, unknown> | undefined) ?? null;
  return {
    id: num(r.id), name: name(r), email: str(r.email), phone: str(r.phoneNumber),
    city: city ? str(city.name) : null,
    status: banStatus(r), // present when the list row carries ban flags; else "ok"
    hasMembership: activeSub(r.userSubscriptions) != null, // only if list row carries subs
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const id = url.searchParams.get("id");

  try {
    // ---- profile ----
    if (id !== null) {
      if (!/^\d+$/.test(id)) return Response.json({ error: "id must be numeric" }, { status: 400 });
      const raw = await apiGet<Record<string, unknown>>(env, `/admin/players/${id}`);
      const d = (raw && typeof raw === "object" && "data" in raw ? (raw.data as Record<string, unknown>) : raw) ?? {};
      const now = Date.now();

      const matchesRaw = Array.isArray(d.matches) ? (d.matches as Record<string, unknown>[]) : [];
      const matches = matchesRaw.map((um) => {
        const m = (um.match as Record<string, unknown>) ?? {};
        const cancelled = um.isCancelled === true || m.isCancelled === true;
        const startUtc = str(m.startDateUtc) ?? str(m.startDate);
        const upcoming = !cancelled && !!startUtc && Date.parse(startUtc) > now;
        return {
          umId: num(um.id), matchId: num(um.matchId ?? m.id), name: str(m.name) ?? `Match ${num(m.id)}`,
          startDate: str(m.startDate), startDateUtc: startUtc,
          team: num(um.team), num: num(um.playerNumber),
          price: num(um.amount) ?? num(m.registrationPrice) ?? 0,
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

      return Response.json({
        env,
        player: {
          id: num(d.id), name: name(d), email: str(d.email), phone: str(d.phoneNumber),
          phoneVerified: d.phoneNumberVerifiedAt != null,
          city: str((d.preferableCity as Record<string, unknown> | undefined)?.name),
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
      });
    }

    // ---- search ----
    if (q !== null) {
      const d = detectKind(q);
      if (d.kind === "empty") return Response.json({ kind: d.kind, results: [] });
      const query = { ...serverQuery(d), limit: 15, page: 1 };
      const r = await apiGet<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(env, `/admin/players`, query);
      const rows = Array.isArray(r) ? r : ((r as { data?: Record<string, unknown>[] }).data ?? []);
      return Response.json({ kind: d.kind, results: rows.map(lightRow) });
    }

    return Response.json({ error: "q or id required" }, { status: 400 });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
