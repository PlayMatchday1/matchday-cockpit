"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// Reads RLS-gated sources directly via the browser client (same pattern
// as AdminUsersView): the firstmatch_repeat_clusters view (the
// actionable flags) and the firstmatch_ledger table (full history).
// Cluster entries are enriched client-side from mdapi_matches (venue +
// venue-local start time) and mdapi_match_players (per-account deletion
// status). All admin-only at the DB layer; the page is AdminGuard-wrapped.

type ClusterEntry = {
  name: string | null;
  claim_date: string;
  city: string | null;
  is_cancelled: boolean;
  user_id: number;
  match_api_id: number | null;
  player_api_id: number;
};

type Cluster = {
  match_type: "phone" | "email";
  match_hash: string;
  claim_count: number;
  distinct_accounts: number;
  first_claim: string;
  last_claim: string;
  entries: ClusterEntry[];
};

type LedgerRow = {
  player_api_id: number;
  user_id: number;
  display_name: string | null;
  phone_hash: string | null;
  email_hash: string | null;
  claim_date: string;
  city_identifier: string | null;
  is_cancelled: boolean;
  is_unrecoverable: boolean;
  source: string;
};

// user_id -> deletion status. deletedApprox is the earliest synced_at at
// which we observed the account's rows scrubbed; approximate because the
// scrub timestamp itself is never logged.
type ScrubInfo = { deleted: boolean; deletedApprox: string | null };
type MatchInfo = { field_title: string | null; start_date: string | null };

// MatchDay scrubs deleted accounts to del_<hex>@playmatchday.com / null
// phone. Inlined (not imported from firstmatchLedger, which pulls in
// node:crypto and would break the browser bundle).
function isScrubbedRow(email: string | null, phone: string | null): boolean {
  return !!email && email.startsWith("del_") && phone === null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Venue-local start time. mdapi_matches.start_date stores the local wall
// time with a cosmetic +00:00 offset (start_date_utc carries the true
// UTC). Parse the wall-clock fields straight from the string — do NOT go
// through Date(), which would convert into the reviewer's browser tz.
function fmtVenueTime(startDate: string | null): string | null {
  if (!startDate) return null;
  const m = startDate.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

export default function FirstMatchReviewView() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [matchMap, setMatchMap] = useState<Map<number, MatchInfo>>(new Map());
  const [scrubMap, setScrubMap] = useState<Map<number, ScrubInfo>>(new Map());
  // player_api_id -> promocode_id (from the source match-player row), and
  // promocode_id -> code text. firstmatchCatalogIds = the free-first-match
  // promo records (code = 'firstmatch'); a claim using one of these is the
  // financial-abuse signal vs a plain repeat.
  const [promoByPlayer, setPromoByPlayer] = useState<Map<number, number | null>>(new Map());
  const [codeById, setCodeById] = useState<Map<number, string>>(new Map());
  const [catalogIds, setCatalogIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The view (migration 0054) is applied separately in the SQL Editor.
  // If it isn't there yet, the ledger table still loads — show a hint.
  const [viewMissing, setViewMissing] = useState(false);

  const [search, setSearch] = useState("");
  const [hideCancelled, setHideCancelled] = useState(false);
  // Default off: show all repeat clusters. On: only clusters where a claim
  // used a free-first-match promo code (the genuine financial abuse).
  const [promoAbuseOnly, setPromoAbuseOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setViewMissing(false);

      // 1. Clusters (the view).
      const clusterRes = await supabase
        .from("firstmatch_repeat_clusters")
        .select("*");
      let loaded: Cluster[] = [];
      if (clusterRes.error) {
        const e = clusterRes.error;
        if (e.code === "42P01" || /does not exist/i.test(e.message)) {
          if (!cancelled) setViewMissing(true);
        } else if (!cancelled) {
          setError(e.message);
          setLoading(false);
          return;
        }
      } else {
        loaded = (clusterRes.data ?? []) as Cluster[];
        if (!cancelled) setClusters(loaded);
      }

      // 2. Enrich cluster entries (small set) with venue + deletion state.
      const userIds = [
        ...new Set(loaded.flatMap((c) => c.entries.map((e) => e.user_id))),
      ];
      const matchIds = [
        ...new Set(
          loaded.flatMap((c) =>
            c.entries
              .map((e) => e.match_api_id)
              .filter((x): x is number => x !== null),
          ),
        ),
      ];

      if (matchIds.length > 0) {
        const { data } = await supabase
          .from("mdapi_matches")
          .select("api_id, field_title, start_date")
          .in("api_id", matchIds);
        const mm = new Map<number, MatchInfo>();
        for (const r of (data ?? []) as {
          api_id: number;
          field_title: string | null;
          start_date: string | null;
        }[]) {
          mm.set(r.api_id, {
            field_title: r.field_title,
            start_date: r.start_date,
          });
        }
        if (!cancelled) setMatchMap(mm);
      }

      if (userIds.length > 0) {
        const sm = new Map<number, ScrubInfo>();
        for (const uid of userIds) sm.set(uid, { deleted: false, deletedApprox: null });

        // Primary deletion oracle: mdapi_users is fully re-synced daily, so
        // it reflects the CURRENT scrub state for every account. (We can't
        // use mdapi_match_players for this — its out-of-window rows are
        // frozen at pre-deletion values and never re-synced, so a deleted
        // account whose claim match is older than the sync window still
        // shows a real email there. That was the regression.)
        const usersRes = await supabase
          .from("mdapi_users")
          .select("id, email, synced_at")
          .in("id", userIds);
        for (const u of (usersRes.data ?? []) as {
          id: number;
          email: string | null;
          synced_at: string;
        }[]) {
          if (!u.email || !u.email.startsWith("del_")) continue;
          // mdapi_users.synced_at is the latest full sync (~today). It's the
          // fallback observation; an earlier player-row scrub (below) wins.
          sm.set(u.id, { deleted: true, deletedApprox: u.synced_at });
        }

        // Refine the approximate date: when the scrub happened to be captured
        // on an in-window match player row, that synced_at is an earlier (and
        // truer) observation of when the account was deleted.
        const playersRes = await supabase
          .from("mdapi_match_players")
          .select("user_id, user_email, user_phone_number, synced_at")
          .in("user_id", userIds);
        for (const r of (playersRes.data ?? []) as {
          user_id: number;
          user_email: string | null;
          user_phone_number: string | null;
          synced_at: string;
        }[]) {
          if (!isScrubbedRow(r.user_email, r.user_phone_number)) continue;
          const cur = sm.get(r.user_id) ?? { deleted: false, deletedApprox: null };
          const earliest =
            cur.deletedApprox && cur.deletedApprox < r.synced_at
              ? cur.deletedApprox
              : r.synced_at;
          sm.set(r.user_id, { deleted: true, deletedApprox: earliest });
        }

        if (!cancelled) setScrubMap(sm);
      }

      // 2b. Promo codes. Resolve promocode_id (which lives on the source
      // match-player rows, not the ledger) to code text via mdapi_promocodes,
      // and capture the free-first-match catalog ids (code = 'firstmatch')
      // dynamically so new firstmatch records are picked up automatically.
      const catalog = new Set<number>();
      const catRes = await supabase
        .from("mdapi_promocodes")
        .select("api_id")
        .ilike("code", "firstmatch");
      for (const r of (catRes.data ?? []) as { api_id: number }[]) {
        catalog.add(r.api_id);
      }

      const pbp = new Map<number, number | null>();
      for (let from = 0; ; from += 1000) {
        const { data, error: pErr } = await supabase
          .from("mdapi_match_players")
          .select("api_id, promocode_id")
          .eq("is_first_match", true)
          .is("deleted_at", null)
          .order("api_id", { ascending: true })
          .range(from, from + 999);
        if (pErr) break; // non-fatal — promo column just falls back to "—"
        const rows = (data ?? []) as {
          api_id: number;
          promocode_id: number | null;
        }[];
        for (const r of rows) pbp.set(r.api_id, r.promocode_id);
        if (rows.length < 1000) break;
      }

      const cbi = new Map<number, string>();
      const distinctPromoIds = [
        ...new Set(
          [...pbp.values()].filter((x): x is number => x !== null),
        ),
      ];
      for (let i = 0; i < distinctPromoIds.length; i += 300) {
        const chunk = distinctPromoIds.slice(i, i + 300);
        const { data } = await supabase
          .from("mdapi_promocodes")
          .select("api_id, code")
          .in("api_id", chunk);
        for (const r of (data ?? []) as { api_id: number; code: string }[]) {
          cbi.set(r.api_id, r.code);
        }
      }

      if (!cancelled) {
        setCatalogIds(catalog);
        setPromoByPlayer(pbp);
        setCodeById(cbi);
      }

      // 3. Full ledger (paginated).
      const all: LedgerRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: lErr } = await supabase
          .from("firstmatch_ledger")
          .select(
            "player_api_id, user_id, display_name, phone_hash, email_hash, claim_date, city_identifier, is_cancelled, is_unrecoverable, source",
          )
          .order("claim_date", { ascending: false })
          .range(from, from + 999);
        if (lErr) {
          if (!cancelled) {
            setError(lErr.message);
            setLoading(false);
          }
          return;
        }
        const rows = (data ?? []) as LedgerRow[];
        all.push(...rows);
        if (rows.length < 1000) break;
      }
      if (!cancelled) {
        setLedger(all);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredLedger = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ledger.filter((r) => {
      if (hideCancelled && r.is_cancelled) return false;
      if (!q) return true;
      return (
        (r.display_name ?? "").toLowerCase().includes(q) ||
        (r.city_identifier ?? "").toLowerCase().includes(q)
      );
    });
  }, [ledger, search, hideCancelled]);

  const cancelledCount = useMemo(
    () => ledger.filter((r) => r.is_cancelled).length,
    [ledger],
  );

  const promoCodeFor = (playerApiId: number): string | null => {
    const pid = promoByPlayer.get(playerApiId);
    if (pid == null) return null;
    return codeById.get(pid) ?? null;
  };

  const clusterUsedFreePromo = (c: Cluster): boolean =>
    c.entries.some((e) => {
      const pid = promoByPlayer.get(e.player_api_id);
      return pid != null && catalogIds.has(pid);
    });

  const visibleClusters = useMemo(
    () =>
      promoAbuseOnly
        ? clusters.filter((c) =>
            c.entries.some((e) => {
              const pid = promoByPlayer.get(e.player_api_id);
              return pid != null && catalogIds.has(pid);
            }),
          )
        : clusters,
    [clusters, promoAbuseOnly, promoByPlayer, catalogIds],
  );

  if (loading) {
    return <p className="text-[13px] text-deep-green/55">Loading…</p>;
  }
  if (error) {
    return <p className="text-[13px] text-red-700">Failed to load: {error}</p>;
  }

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-6">
      {/* ── Left column: flagged repeat clusters ── */}
      <section className="lg:w-[44%] lg:shrink-0 lg:max-h-[calc(100vh-180px)] lg:overflow-y-auto lg:pr-1">
        <h2 className="mb-1 text-[15px] font-bold tracking-tight text-deep-green">
          Flagged repeats
        </h2>
        <p className="mb-3 text-[12px] text-deep-green/55">
          Same phone or email across two or more accounts. Review only — not an
          auto-denial. Shared or recycled numbers produce false positives.
        </p>

        {!viewMissing && clusters.length > 0 && (
          <label className="mb-3 flex items-center gap-1.5 text-[12px] text-deep-green/70">
            <input
              type="checkbox"
              checked={promoAbuseOnly}
              onChange={(e) => setPromoAbuseOnly(e.target.checked)}
            />
            Promo abuse only
            <span className="text-deep-green/45">
              ({visibleClusters.length} of {clusters.length})
            </span>
          </label>
        )}

        {viewMissing ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Detection view not found. Apply migration{" "}
            <code>0054_firstmatch_repeat_clusters.sql</code> in the Supabase SQL
            Editor to enable cluster detection. The full ledger is unaffected.
          </div>
        ) : clusters.length === 0 ? (
          <p className="text-[13px] text-deep-green/55">
            No repeat clusters detected.
          </p>
        ) : visibleClusters.length === 0 ? (
          <p className="text-[13px] text-deep-green/55">
            No clusters used a free first-match promo code.
          </p>
        ) : (
          <div className="space-y-3">
            {visibleClusters.map((c) => (
              <div
                key={`${c.match_type}:${c.match_hash}`}
                className="rounded-md border border-cream-line"
              >
                <div className="flex items-center gap-2 border-b border-cream-line px-3 py-2">
                  <span
                    className={
                      c.match_type === "phone"
                        ? "rounded bg-mint-hover/20 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-deep-green"
                        : "rounded bg-deep-green/10 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-deep-green"
                    }
                  >
                    {c.match_type} match
                  </span>
                  <span className="text-[13px] font-semibold text-deep-green">
                    {c.distinct_accounts} accounts
                  </span>
                  <span className="text-[12px] text-deep-green/55">
                    {c.claim_count} claims
                  </span>
                  {clusterUsedFreePromo(c) ? (
                    <span className="ml-auto shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">
                      Free promo used
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 rounded bg-deep-green/5 px-1.5 py-0.5 text-[11px] font-medium text-deep-green/50">
                      Full-price repeats
                    </span>
                  )}
                </div>
                <ul>
                  {c.entries.map((e) => {
                    const match = e.match_api_id
                      ? matchMap.get(e.match_api_id)
                      : undefined;
                    const venue = match?.field_title ?? null;
                    const time = fmtVenueTime(match?.start_date ?? null);
                    const scrub = scrubMap.get(e.user_id);
                    const code = promoCodeFor(e.player_api_id);
                    const meta = [
                      fmtDate(e.claim_date),
                      e.city ?? null,
                      venue,
                      time,
                      `promo: ${code ?? "—"}`,
                      e.is_cancelled ? "cancelled" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li
                        key={e.player_api_id}
                        className="border-b border-cream-line/60 px-3 py-2 last:border-0"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-medium text-deep-green">
                            {e.name ?? "(no name)"}
                          </span>
                          {scrub?.deleted ? (
                            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
                              Deleted ~ {fmtDate(scrub.deletedApprox)}
                            </span>
                          ) : (
                            <span className="shrink-0 rounded bg-mint-hover/20 px-1.5 py-0.5 text-[11px] font-semibold text-deep-green">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-deep-green/55">
                          {meta}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Right column: full ledger ── */}
      <section className="lg:flex-1 lg:max-h-[calc(100vh-180px)] lg:overflow-y-auto">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-bold tracking-tight text-deep-green">
            All claims
          </h2>
          <span className="text-[12px] text-deep-green/55">
            {filteredLedger.length} of {ledger.length}
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or city…"
            className="ml-auto w-56 rounded border border-cream-line px-2 py-1 text-[13px] text-deep-green outline-none focus:border-mint-hover"
          />
          <label className="flex items-center gap-1.5 text-[12px] text-deep-green/70">
            <input
              type="checkbox"
              checked={hideCancelled}
              onChange={(e) => setHideCancelled(e.target.checked)}
            />
            Hide cancelled ({cancelledCount})
          </label>
        </div>

        <div className="overflow-x-auto rounded-md border border-cream-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-cream-line text-left text-[11px] uppercase tracking-wide text-deep-green/55">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Claim date</th>
                <th className="px-3 py-2 font-semibold">City</th>
                <th className="px-3 py-2 font-semibold">Promo</th>
                <th className="px-3 py-2 font-semibold">Identifiers</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody>
              {filteredLedger.map((r) => (
                <tr
                  key={r.player_api_id}
                  className="border-b border-cream-line/60 last:border-0"
                >
                  <td className="px-3 py-1.5 font-medium text-deep-green">
                    {r.display_name ?? "(no name)"}
                  </td>
                  <td className="px-3 py-1.5 text-deep-green/70">
                    {fmtDate(r.claim_date)}
                  </td>
                  <td className="px-3 py-1.5 text-deep-green/70">
                    {r.city_identifier ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-deep-green/70">
                    {promoCodeFor(r.player_api_id) ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-deep-green/55">
                    {r.is_unrecoverable
                      ? "identity scrubbed"
                      : [r.phone_hash ? "phone" : null, r.email_hash ? "email" : null]
                          .filter(Boolean)
                          .join(" + ") || "—"}
                  </td>
                  <td className="px-3 py-1.5 text-deep-green/70">
                    {r.is_cancelled ? "cancelled" : "active"}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-deep-green/45">
                    {r.source}
                  </td>
                </tr>
              ))}
              {filteredLedger.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-4 text-center text-[13px] text-deep-green/55"
                  >
                    No matching claims.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
