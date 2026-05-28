"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// Reads two RLS-gated sources directly via the browser client (same
// pattern as AdminUsersView): the firstmatch_repeat_clusters view (the
// actionable flags) and the firstmatch_ledger table (the full history).
// Both are admin-only at the DB layer; this page is also wrapped in
// AdminGuard.

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

export default function FirstMatchReviewView() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The view (migration 0054) is applied separately in the SQL Editor.
  // If it isn't there yet, the ledger table still loads — show a hint
  // instead of erroring the whole page.
  const [viewMissing, setViewMissing] = useState(false);

  const [search, setSearch] = useState("");
  const [hideCancelled, setHideCancelled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setViewMissing(false);

      // Clusters (the view).
      const clusterRes = await supabase
        .from("firstmatch_repeat_clusters")
        .select("*");
      if (clusterRes.error) {
        const e = clusterRes.error;
        if (e.code === "42P01" || /does not exist/i.test(e.message)) {
          if (!cancelled) setViewMissing(true);
        } else if (!cancelled) {
          setError(e.message);
          setLoading(false);
          return;
        }
      } else if (!cancelled) {
        setClusters((clusterRes.data ?? []) as Cluster[]);
      }

      // Full ledger (paginated — a few thousand rows).
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

  if (loading) {
    return <p className="text-[13px] text-deep-green/55">Loading…</p>;
  }
  if (error) {
    return (
      <p className="text-[13px] text-red-700">
        Failed to load: {error}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── Flagged repeat clusters ── */}
      <section>
        <h2 className="mb-1 text-[15px] font-bold tracking-tight text-deep-green">
          Flagged repeats
        </h2>
        <p className="mb-3 text-[12px] text-deep-green/55">
          Same phone or email across two or more accounts. Review only — not
          an auto-denial. Shared or recycled numbers produce false positives.
        </p>

        {viewMissing ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Detection view not found. Apply migration{" "}
            <code>0054_firstmatch_repeat_clusters.sql</code> in the Supabase SQL
            Editor to enable cluster detection. The full ledger below is
            unaffected.
          </div>
        ) : clusters.length === 0 ? (
          <p className="text-[13px] text-deep-green/55">
            No repeat clusters detected.
          </p>
        ) : (
          <div className="space-y-3">
            {clusters.map((c) => (
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
                    {c.claim_count} claims · {fmtDate(c.first_claim)} →{" "}
                    {fmtDate(c.last_claim)}
                  </span>
                </div>
                <table className="w-full text-[13px]">
                  <tbody>
                    {c.entries.map((e) => (
                      <tr
                        key={e.player_api_id}
                        className="border-b border-cream-line/60 last:border-0"
                      >
                        <td className="px-3 py-1.5 font-medium text-deep-green">
                          {e.name ?? "(no name)"}
                        </td>
                        <td className="px-3 py-1.5 text-deep-green/70">
                          {fmtDate(e.claim_date)}
                        </td>
                        <td className="px-3 py-1.5 text-deep-green/70">
                          {e.city ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-deep-green/45">
                          {e.is_cancelled ? "cancelled" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Full ledger ── */}
      <section>
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
            Hide cancelled
          </label>
        </div>

        <div className="overflow-x-auto rounded-md border border-cream-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-cream-line text-left text-[11px] uppercase tracking-wide text-deep-green/55">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Claim date</th>
                <th className="px-3 py-2 font-semibold">City</th>
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
                    colSpan={6}
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
