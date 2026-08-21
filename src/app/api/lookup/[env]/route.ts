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

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { cityNameFor } from "@/lib/cityScope";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
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
  const auth = await authenticateMatchOpsRead(req);
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
      // Detail + list, in parallel. preferableCity is on the LIST row but NOT the detail
      // payload (confirmed live), so the profile reads it from the list — otherwise the
      // header renders "—" for a field the API actually has.
      const [raw, listRow] = await Promise.all([
        apiGet<Record<string, unknown>>(env, `/admin/players/${id}`),
        apiGet<{ data?: Record<string, unknown>[] }>(env, `/admin/players`, { id, limit: 1, page: 1 })
          .then((r) => (Array.isArray(r) ? r[0] : (r.data ?? [])[0]) ?? null)
          .catch(() => null),
      ]);
      /* ── WHAT "A WARSAW PLAYER" IS ───────────────────────────────────────────────────────────
       * The only city a PLAYER carries is preferableCity — their own declared city, on the list
       * row. The alternatives were: (a) this field, (b) "has played ≥1 Warsaw match", (c) "has
       * played ONLY Warsaw matches". (b) and (c) are derivations over match history, which the
       * SEARCH endpoint does not return at all — so neither can filter a search without fetching
       * every candidate's profile first.
       *
       * PICKED: (a) preferableCity — BUT IT IS A PREFERENCE, NOT A FACT, and nothing here should
       * be read as though the platform knows where a player belongs. It is a setting the player
       * chose. Both errors follow directly:
       *   · a Warsaw regular who set "Austin" is INVISIBLE to the Warsaw account;
       *   · an Austin regular who set "Warsaw" is VISIBLE to it.
       * It is used because it is the only city that exists at player level, not because it is
       * right. Treat it as a soft SORT of the search list, never as the boundary.
       *
       * THE BOUNDARY IS THIS REFUSAL. Omitting someone from a list does not stop ?id= being typed,
       * so a request for a player outside the scope is refused outright — 403, not a filtered-empty
       * result, so the difference between "no such player" and "not yours" stays visible to us and
       * invisible to them. */
      if (auth.confinedCity) {
        const want = cityNameFor(auth.confinedCity);
        const lr = (listRow ?? {}) as Record<string, unknown>;
        const pc = (lr.preferableCity as Record<string, unknown> | undefined) ?? null;
        const has = pc ? str(pc.name) : null;
        if (has !== want) return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
      }
      const d = (raw && typeof raw === "object" && "data" in raw ? (raw.data as Record<string, unknown>) : raw) ?? {};
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
        let by: string | null = byId != null ? `user ${byId}` : null;
        if (byId != null) {
          const b = await apiGet<Record<string, unknown>>(env, `/admin/players/${byId}`).catch(() => null);
          const bd = b && typeof b === "object" && "data" in b ? (b.data as Record<string, unknown>) : b;
          if (bd) by = name(bd);
        }
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

      return Response.json({
        env,
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
      });
    }

    // ---- search ----
    if (q !== null) {
      const d = detectKind(q);
      if (d.kind === "empty") return Response.json({ kind: d.kind, results: [] });
      const query = { ...serverQuery(d), limit: 15, page: 1 };
      const r = await apiGet<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(env, `/admin/players`, query);
      const rows = Array.isArray(r) ? r : ((r as { data?: Record<string, unknown>[] }).data ?? []);
      // THE SEARCH LIST, SCOPED. Filtered on the server before serialization — the upstream
      // /admin/players has no city parameter, so this cannot be an in-query filter; what it can be
      // is a filter no row escapes, and a `results` array whose length is the filtered length.
      let results = rows.map(lightRow);
      if (auth.confinedCity) {
        const want = cityNameFor(auth.confinedCity);
        results = results.filter((r) => r.city === want);
      }
      return Response.json({ kind: d.kind, results });
    }

    return Response.json({ error: "q or id required" }, { status: 400 });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
