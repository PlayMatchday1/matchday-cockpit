"use client";

// Reviews for a CITY MANAGER. The tier had no Reviews page until now for a specific reason: every
// review surface pulled the whole of mdapi_reviews into the browser and filtered in JS, so scoping
// one would have meant shipping every city's reviews — names, emails, comments — to a city
// manager's machine and hiding most of them.
//
// This page holds no filter of its own. It renders what /api/reviews returns, and that endpoint
// decides the scope from the caller's session — never from anything this page could send.

import { useMemo } from "react";
import { useAuth, isCityManager } from "@/lib/useAuth";
import { useScopedReviews } from "@/lib/reviewsData";
import { cityNameFor } from "@/lib/cityScope";
import CityNav from "../CityNav";

export default function CityReviewsPage() {
  const { appUser, isLoading } = useAuth();
  const { rows, scope, loading, error } = useScopedReviews();

  const stats = useMemo(() => {
    const rated = rows.filter((r) => r.starRating != null);
    const withComment = rated.filter((r) => (r.comment ?? "").trim() !== "");
    const sum = rated.reduce((s, r) => s + r.starRating, 0);
    return {
      total: rated.length,
      answered: withComment.length,
      unanswered: rated.length - withComment.length,
      avg: rated.length ? (sum / rated.length).toFixed(2) : "—",
      // sorted by MATCH START, newest first — the order a city manager reads them in
      recent: [...rated].sort((a, b) => b.startDate.getTime() - a.startDate.getTime()),
    };
  }, [rows]);

  if (isLoading) return <div className="p-6 text-sm text-deep-green/50">Loading…</div>;
  if (!isCityManager(appUser) && !appUser?.is_admin) {
    return <div className="p-6 text-sm text-coral" data-testid="cr-denied">Reviews requires Admin or the City Manager tier.</div>;
  }

  return (
    <div className="p-4" data-testid="city-reviews">
      <CityNav />
      <h1 className="text-xl font-extrabold tracking-tight text-deep-green">
        Reviews{scope ? ` · ${cityNameFor(scope) ?? scope}` : ""}
      </h1>
      <p className="mt-1 text-xs text-deep-green/60" data-testid="cr-scope-note">
        {scope
          ? "Scoped on the server to your city — this page never receives another city's reviews."
          : "All cities."}
      </p>

      {error && <div className="mt-4 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral" data-testid="cr-error">{error}</div>}
      {loading && <div className="mt-4 text-sm text-deep-green/50">Loading reviews…</div>}

      {!loading && !error && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="cr-metrics">
            <Metric k="REVIEWS" v={String(stats.total)} testid="cr-total" />
            <Metric k="AVERAGE" v={stats.avg} testid="cr-avg" />
            <Metric k="WITH A COMMENT" v={String(stats.answered)} testid="cr-answered" />
            <Metric k="RATING ONLY" v={String(stats.unanswered)} testid="cr-unanswered" />
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" data-testid="cr-table">
                <thead>
                  <tr className="border-b border-cream-line bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                    <th className="px-3 py-3 text-left">Match date</th>
                    <th className="px-3 py-3 text-left">City</th>
                    <th className="px-3 py-3 text-left">Field</th>
                    <th className="px-2 py-3 text-center">Stars</th>
                    <th className="px-3 py-3 text-left">Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-deep-green/50">No reviews yet.</td></tr>
                  )}
                  {stats.recent.slice(0, 200).map((r) => (
                    <tr key={r.apiId} className="border-t border-cream-line/40" data-testid="cr-row" data-city={r.city}>
                      <td className="px-3 py-2 text-deep-green/75">{r.startDate.toISOString().slice(0, 10)}</td>
                      <td className="px-3 py-2 text-deep-green/75" data-testid="cr-row-city">{r.city}</td>
                      <td className="px-3 py-2 text-deep-green/75">{r.fieldTitle}</td>
                      <td className="px-2 py-2 text-center font-bold text-deep-green">{r.starRating}</td>
                      <td className="px-3 py-2 text-deep-green/75">{(r.comment ?? "").trim() || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ k, v, testid }: { k: string; v: string; testid: string }) {
  return (
    <div className="rounded-xl border border-cream-line bg-white px-3 py-3" data-testid={testid} data-value={v}>
      <div className="text-[9.5px] font-extrabold tracking-widest text-deep-green/50">{k}</div>
      <div className="mt-1 text-2xl font-extrabold tracking-tight text-deep-green">{v}</div>
    </div>
  );
}
