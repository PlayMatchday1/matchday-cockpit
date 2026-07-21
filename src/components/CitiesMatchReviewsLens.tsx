"use client";

// Cities → Match Reviews. One row per reviewed match (from mdapi_matches'
// per-match star_rating/count), with tags + comments joined from
// mdapi_reviews. Surfaces low- and high-scoring matches so managers can be
// coached. Sibling of the existing Reviews lens, which stays.
//
// Grain caveat: reviews carry no match_id, so they join to matches by
// (start_date-minute, field_title). Both sources are daily snapshots — a
// "reviews synced as of" note keeps the staleness honest.

import { useMemo, useState } from "react";
import { useMatchReviews, type MatchReviewRow } from "@/lib/useMatchReviews";
import { useReviewData, type ReviewRow } from "@/lib/useReviewData";
import { classifyTag } from "@/lib/reviewTags";
import {
  fmtMatchDateTime,
  matchLocalDate,
  matchLocalMonth,
  windowCutoffIso,
} from "@/lib/matchTime";

// Highlight thresholds — tunable. A match needs at least MIN_REVIEWS to
// qualify for either list, so a lone 1★ or 5★ never headlines.
const NEEDS_ATTENTION_MAX = 3.5; // avg strictly below → needs attention
const STANDOUT_MIN = 4.8; // avg at/above → standout
const HIGHLIGHT_MIN_REVIEWS = 3;
// The highlight panels are a rolling "act now" window (today inclusive),
// independent of the month filter. Tunable.
const HIGHLIGHT_WINDOW_DAYS = 3;
const HIGHLIGHT_WINDOW_LABEL = `last ${HIGHLIGHT_WINDOW_DAYS} days`;

const ALL = "ALL";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Minute-precision key from a review's parsed Date (local components round-
// trip the UTC wall-clock parseLocal stored).
function minuteKeyFromDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split("-");
  return `${MONTHS[Number(mo) - 1]} ${y}`;
}
function managerName(fn: string | null, ln: string | null): string {
  const n = `${fn ?? ""} ${ln ?? ""}`.trim();
  return n || "Unknown";
}
function fmtRating(n: number): string {
  return n.toFixed(2).replace(/\.00$/, ".0");
}
function fmtSyncedAt(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type EnrichedMatch = MatchReviewRow & {
  manager: string;
  month: string;
  reviews: ReviewRow[];
  tagCounts: [string, number][]; // sorted desc
};

export default function CitiesMatchReviewsLens({
  // When rendered as a sub-tab of the Reviews lens, the outer lens + the
  // "Match Reviews" sub-tab pill already title it, so hide the local h2.
  embedded = false,
}: { embedded?: boolean } = {}) {
  const { rows: matches, syncedAt, loading, error } = useMatchReviews();
  const { rows: reviews } = useReviewData();

  // Index reviews by (minute, field_title) so each match can pull its own.
  const reviewsByKey = useMemo(() => {
    const map = new Map<string, ReviewRow[]>();
    for (const r of reviews) {
      const key = `${minuteKeyFromDate(r.startDate)}|${r.fieldTitle}`;
      const arr = map.get(key);
      if (arr) arr.push(r);
      else map.set(key, [r]);
    }
    return map;
  }, [reviews]);

  const enriched: EnrichedMatch[] = useMemo(() => {
    return matches.map((m) => {
      const key = `${m.startDate.slice(0, 16)}|${m.fieldTitle}`;
      const rvs = reviewsByKey.get(key) ?? [];
      const counts = new Map<string, number>();
      for (const rv of rvs) for (const t of rv.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      return {
        ...m,
        manager: managerName(m.managerFirstName, m.managerLastName),
        month: matchLocalMonth(m.startDate),
        reviews: rvs.slice().sort((a, b) => a.starRating - b.starRating),
        tagCounts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
      };
    });
  }, [matches, reviewsByKey]);

  // Filter options.
  const monthOptions = useMemo(
    () => [...new Set(enriched.map((m) => m.month))].sort().reverse(),
    [enriched],
  );
  const [month, setMonth] = useState<string>("");
  const activeMonth = month || monthOptions[0] || "";

  const [city, setCity] = useState<string>(ALL);
  const [venue, setVenue] = useState<string>(ALL);
  const [manager, setManager] = useState<string>(ALL);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const monthMatches = useMemo(
    () => enriched.filter((m) => m.month === activeMonth),
    [enriched, activeMonth],
  );
  const cityOptions = useMemo(
    () => [ALL, ...[...new Set(monthMatches.map((m) => m.city))].sort()],
    [monthMatches],
  );
  const venueOptions = useMemo(
    () =>
      [ALL, ...[...new Set(monthMatches.filter((m) => city === ALL || m.city === city).map((m) => m.fieldTitle))].sort()],
    [monthMatches, city],
  );
  const managerOptions = useMemo(
    () => [ALL, ...[...new Set(monthMatches.map((m) => m.manager))].sort()],
    [monthMatches],
  );

  const filtered = useMemo(() => {
    return monthMatches
      .filter((m) => city === ALL || m.city === city)
      .filter((m) => venue === ALL || m.fieldTitle === venue)
      .filter((m) => manager === ALL || m.manager === manager)
      // Newest match first (most recent date/time at the top).
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }, [monthMatches, city, venue, manager]);

  // Highlight pool: a rolling last-N-days window (today inclusive),
  // independent of the month filter — these are operational "act now" lists,
  // not monthly archives. City / venue / manager filters still apply so a
  // city manager can scope to their own recent matches. Newest first.
  const recentPool = useMemo(() => {
    // Window on the venue-LOCAL match day (start_date), consistent with what
    // the rows display. Future matches are already excluded upstream via the
    // true UTC instant, so this can't admit tonight's not-yet-played matches.
    const cutoffIso = windowCutoffIso(new Date(), HIGHLIGHT_WINDOW_DAYS);
    return enriched
      .filter((m) => matchLocalDate(m.startDate) >= cutoffIso)
      .filter((m) => city === ALL || m.city === city)
      .filter((m) => venue === ALL || m.fieldTitle === venue)
      .filter((m) => manager === ALL || m.manager === manager)
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }, [enriched, city, venue, manager]);

  const needsAttention = recentPool.filter(
    (m) => m.reviewCount >= HIGHLIGHT_MIN_REVIEWS && m.avgRating < NEEDS_ATTENTION_MAX,
  );
  const standouts = recentPool.filter(
    (m) => m.reviewCount >= HIGHLIGHT_MIN_REVIEWS && m.avgRating >= STANDOUT_MIN,
  );

  // Summary (over the filtered set).
  const summary = useMemo(() => {
    const volume = filtered.reduce((s, m) => s + m.reviewCount, 0);
    const weighted = filtered.reduce((s, m) => s + m.avgRating * m.reviewCount, 0);
    const avg = volume > 0 ? weighted / volume : 0;
    const byMgr = new Map<string, { stars: number; count: number }>();
    for (const m of filtered) {
      const e = byMgr.get(m.manager) ?? { stars: 0, count: 0 };
      e.stars += m.avgRating * m.reviewCount;
      e.count += m.reviewCount;
      byMgr.set(m.manager, e);
    }
    const managers = [...byMgr.entries()]
      .map(([name, e]) => ({ name, avg: e.count > 0 ? e.stars / e.count : 0, count: e.count }))
      .sort((a, b) => b.count - a.count);
    return { volume, avg, managers, matchCount: filtered.length };
  }, [filtered]);

  if (loading) {
    return (
      <section>
        <Header embedded={embedded} />
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading match reviews…
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <Header embedded={embedded} />
        <div className="rounded-2xl border-[1.5px] border-coral/40 bg-coral-soft/40 p-8 text-sm text-coral">
          Failed to load match reviews: {error}
        </div>
      </section>
    );
  }

  return (
    <section>
      <Header syncedAt={syncedAt} embedded={embedded} />

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Month">
          <Select value={activeMonth} onChange={(v) => { setMonth(v); setCity(ALL); setVenue(ALL); setManager(ALL); }}>
            {monthOptions.map((m) => (
              <option key={m} value={m}>{monthLabel(m)}</option>
            ))}
          </Select>
        </Filter>
        <Filter label="City">
          <Select value={city} onChange={(v) => { setCity(v); setVenue(ALL); }}>
            {cityOptions.map((c) => (<option key={c} value={c}>{c === ALL ? "All" : c}</option>))}
          </Select>
        </Filter>
        <Filter label="Venue">
          <Select value={venue} onChange={setVenue}>
            {venueOptions.map((v) => (<option key={v} value={v}>{v === ALL ? "All" : v}</option>))}
          </Select>
        </Filter>
        <Filter label="Manager">
          <Select value={manager} onChange={setManager}>
            {managerOptions.map((mg) => (<option key={mg} value={mg}>{mg === ALL ? "All" : mg}</option>))}
          </Select>
        </Filter>
      </div>

      {/* Summary strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={`Avg rating · ${monthLabel(activeMonth || "")}`} value={summary.volume ? fmtRating(summary.avg) : "—"} sub={`${summary.matchCount} matches`} />
        <Kpi label="Review volume" value={summary.volume.toLocaleString()} sub="this selection" />
        <Kpi label={`Needs attention · ${HIGHLIGHT_WINDOW_LABEL}`} value={String(needsAttention.length)} sub={`avg < ${NEEDS_ATTENTION_MAX}, ≥${HIGHLIGHT_MIN_REVIEWS} reviews`} tone={needsAttention.length ? "coral" : undefined} />
        <Kpi label={`Standouts · ${HIGHLIGHT_WINDOW_LABEL}`} value={String(standouts.length)} sub={`avg ≥ ${STANDOUT_MIN}, ≥${HIGHLIGHT_MIN_REVIEWS} reviews`} tone={standouts.length ? "mint" : undefined} />
      </div>

      {/* By-manager mini-table */}
      {summary.managers.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
          <div className="border-b border-cream-line bg-cream-soft/50 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            By manager · {monthLabel(activeMonth || "")}
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {summary.managers.map((mg) => (
                  <tr key={mg.name} className="border-t border-cream-line/40 first:border-t-0">
                    <td className="px-4 py-1.5 font-semibold text-deep-green">{mg.name}</td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-deep-green">{fmtRating(mg.avg)}★</td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-deep-green/60">{mg.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Highlights — rolling window, always shown so the "last 3 days" state
          (incl. "none") is explicit, independent of the month filter. */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <HighlightCard title="Needs attention" tone="coral" matches={needsAttention} onOpen={setOpenKey} openKey={openKey} />
        <HighlightCard title="Standouts" tone="mint" matches={standouts} onOpen={setOpenKey} openKey={openKey} />
      </div>

      {/* All reviewed matches */}
      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr className="border-b border-cream-line">
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-left">City</th>
                <th className="px-3 py-2 text-left">Manager</th>
                <th className="px-3 py-2 text-right">Reviews</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2 text-left">Tags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-deep-green/55">No reviewed matches for these filters.</td></tr>
              ) : (
                filtered.map((m) => (
                  <MatchRow key={m.apiId} m={m} open={openKey === String(m.apiId)} onToggle={() => setOpenKey(openKey === String(m.apiId) ? null : String(m.apiId))} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Header({ syncedAt, embedded }: { syncedAt?: string | null; embedded?: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-2">
      {embedded ? (
        <p className="text-sm text-deep-green/60">Per-match review performance — low- and high-scoring matches.</p>
      ) : (
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">Match Reviews</h2>
          <p className="mt-1 text-sm text-deep-green/60">Per-match review performance — low- and high-scoring matches.</p>
        </div>
      )}
      {syncedAt !== undefined && (
        <span className="rounded-full border border-cream-line bg-cream-soft px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          reviews synced as of {fmtSyncedAt(syncedAt ?? null)}
        </span>
      )}
    </div>
  );
}

function MatchRow({ m, open, onToggle }: { m: EnrichedMatch; open: boolean; onToggle: () => void }) {
  const ratingTone =
    m.reviewCount >= HIGHLIGHT_MIN_REVIEWS && m.avgRating < NEEDS_ATTENTION_MAX
      ? "text-coral"
      : m.reviewCount >= HIGHLIGHT_MIN_REVIEWS && m.avgRating >= STANDOUT_MIN
        ? "text-mint-hover"
        : "text-deep-green";
  return (
    <>
      <tr className="cursor-pointer border-t border-cream-line/40 hover:bg-cream-soft/50" onClick={onToggle}>
        <td className="px-3 py-2 whitespace-nowrap font-semibold text-deep-green">{fmtMatchDateTime(m.startDate)}</td>
        <td className="px-3 py-2 text-deep-green/85">{m.fieldTitle}</td>
        <td className="px-3 py-2 text-deep-green/70">{m.city}</td>
        <td className="px-3 py-2 text-deep-green/85">{m.manager}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/70">{m.reviewCount}</td>
        <td className={`px-3 py-2 text-right font-mono font-bold tabular-nums ${ratingTone}`}>{fmtRating(m.avgRating)}★</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {m.tagCounts.slice(0, 4).map(([tag, n]) => (<TagChip key={tag} tag={tag} count={n} />))}
            {m.tagCounts.length > 4 && <span className="text-[10px] text-deep-green/45">+{m.tagCounts.length - 4}</span>}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="bg-cream-soft/40">
          <td colSpan={7} className="px-5 py-3">
            <ReviewDetail m={m} />
          </td>
        </tr>
      )}
    </>
  );
}

function ReviewDetail({ m }: { m: EnrichedMatch }) {
  if (m.reviews.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        {m.reviewCount} rating{m.reviewCount === 1 ? "" : "s"} on the match, but no individual reviews synced yet.
      </div>
    );
  }
  return (
    <div>
      {m.reviews.length < m.reviewCount && (
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#9a6a00]">
          showing {m.reviews.length} of {m.reviewCount} synced
        </div>
      )}
      <div className="space-y-2">
        {m.reviews.map((r, i) => (
          <div key={i} className="rounded-lg border border-cream-line bg-white px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-deep-green">{r.starRating}★</span>
              <span className="text-[11px] text-deep-green/60">
                {`${r.userFirstName ?? ""} ${r.userLastName ?? ""}`.trim() || "Member"}
              </span>
              {r.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {r.tags.map((t) => (<TagChip key={t} tag={t} />))}
                </div>
              )}
            </div>
            {r.comment && <div className="mt-1 text-xs text-deep-green/80">“{r.comment}”</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TagChip({ tag, count }: { tag: string; count?: number }) {
  const cat = classifyTag(tag);
  const cls =
    cat === "negative"
      ? "bg-coral-soft/50 text-coral border-coral/30"
      : cat === "positive"
        ? "bg-mint-soft/50 text-deep-green border-mint/40"
        : "bg-cream-soft text-deep-green/70 border-cream-line";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${cls}`}>
      {tag}
      {count != null && count > 1 && <span className="opacity-70">×{count}</span>}
    </span>
  );
}

function HighlightCard({ title, tone, matches, onOpen, openKey }: {
  title: string; tone: "coral" | "mint"; matches: EnrichedMatch[];
  onOpen: (k: string | null) => void; openKey: string | null;
}) {
  const border = tone === "coral" ? "border-coral/40" : "border-mint/50";
  const head = tone === "coral" ? "text-coral" : "text-mint-hover";
  return (
    <div className={`overflow-hidden rounded-2xl border-[1.5px] ${border} bg-white shadow-md shadow-deep-green/10`}>
      <div className={`flex items-baseline gap-2 border-b border-cream-line bg-cream-soft/40 px-4 py-2 text-xs font-bold uppercase tracking-wider ${head}`}>
        <span>{title} · {matches.length}</span>
        <span className="text-[10px] font-semibold normal-case text-deep-green/45">{HIGHLIGHT_WINDOW_LABEL}</span>
      </div>
      {matches.length === 0 ? (
        <div className="px-4 py-4 text-xs text-deep-green/50">None in the {HIGHLIGHT_WINDOW_LABEL}.</div>
      ) : (
        <ul className="divide-y divide-cream-line/40">
          {matches.map((m) => (
            <li key={m.apiId} className="cursor-pointer px-4 py-2 hover:bg-cream-soft/50" onClick={() => onOpen(openKey === String(m.apiId) ? null : String(m.apiId))}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-deep-green">{m.fieldTitle}</span>
                <span className={`font-mono text-xs font-bold ${head}`}>{fmtRating(m.avgRating)}★ ({m.reviewCount})</span>
              </div>
              <div className="text-[11px] text-deep-green/55">{fmtMatchDateTime(m.startDate)} · {m.city} · {m.manager}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "coral" | "mint" }) {
  const valCls = tone === "coral" ? "text-coral" : tone === "mint" ? "text-mint-hover" : "text-deep-green";
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white px-4 py-3 shadow-md shadow-deep-green/10">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-deep-green/45">{sub}</div>}
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">{label}</div>
      {children}
    </label>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
    >
      {children}
    </select>
  );
}
