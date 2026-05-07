"use client";

// Manager of the Month leaderboard. Dark-themed, screenshot-targeted
// section embedded in the /cities Reviews tab above the existing
// "Last 8 weeks" rating chart.
//
// Visual prototype: leaderboard-reference.html (dark theme, Bebas Neue
// + Fraunces + JetBrains Mono fonts, podium / company YTD / by-city /
// full standings / monthly trend bars). Match pixel-for-pixel — the
// section is screenshotted to WhatsApp and the contrast against the
// rest of the cream/green app is intentional.
//
// Aggregation / sort / pacing rules mirror the prototype's render()
// pipeline 1:1 (qualified at 50+ reviews, on-pace via projected count,
// rank by avg rating with review-count tiebreaker, top-3 podium from
// eligible = qualified ∪ on-pace).
//
// CSS scope: every rule is nested under `.manager-leaderboard` so the
// dark theme + custom CSS variables don't leak into the rest of the
// app. Animation keyframes are mlb-prefixed to avoid global collisions.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewRow } from "@/lib/useReviewData";

const MINIMUM_REVIEWS = 50;

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type ManagerAgg = {
  name: string;
  city: string;
  sum: number;
  count: number;
  avg: number;
  qualified: boolean;
  onPace: boolean;
  offPace: boolean;
  projected: number;
};

type CityAgg = {
  name: string;
  sum: number;
  count: number;
  managerCount: number;
  avg: number;
};

type MonthBucket = {
  idx: number;
  name: string;
  avg: number;
  count: number;
  partial: boolean;
};

// -----------------------------------------------------------------
// Aggregation — mirrors leaderboard-reference.html render() lines
// 1042-1100. Splits into managers + cities + per-month YTD.
// -----------------------------------------------------------------

function aggregateManagers(
  rows: ReviewRow[],
  today: number,
  daysInMonth: number,
): ManagerAgg[] {
  const byName = new Map<
    string,
    { name: string; sum: number; count: number; cityCounts: Record<string, number> }
  >();
  for (const r of rows) {
    const name = (r.managerFirstName ?? "").trim();
    if (!name) continue;
    const rating = Number(r.starRating);
    if (Number.isNaN(rating)) continue;
    const city = (r.city ?? "").trim();
    let m = byName.get(name);
    if (!m) {
      m = { name, sum: 0, count: 0, cityCounts: {} };
      byName.set(name, m);
    }
    m.sum += rating;
    m.count += 1;
    if (city) m.cityCounts[city] = (m.cityCounts[city] ?? 0) + 1;
  }

  const out: ManagerAgg[] = [];
  for (const m of byName.values()) {
    const avg = m.count > 0 ? m.sum / m.count : 0;
    const qualified = m.count >= MINIMUM_REVIEWS;
    const projected = today > 0 ? (m.count / today) * daysInMonth : 0;
    const onPace = !qualified && projected >= MINIMUM_REVIEWS;
    const offPace = !qualified && !onPace;
    const cityEntries = Object.entries(m.cityCounts);
    const city =
      cityEntries.length > 0
        ? cityEntries.sort((a, b) => b[1] - a[1])[0][0]
        : "—";
    out.push({
      name: m.name,
      city,
      sum: m.sum,
      count: m.count,
      avg,
      qualified,
      onPace,
      offPace,
      projected,
    });
  }

  // Sort: eligible (qualified ∪ on-pace) first, then by avg desc,
  // tie-break by count desc. Matches reference render() sort logic.
  out.sort((a, b) => {
    const aE = a.qualified || a.onPace ? 1 : 0;
    const bE = b.qualified || b.onPace ? 1 : 0;
    if (aE !== bE) return bE - aE;
    if (b.avg !== a.avg) return b.avg - a.avg;
    return b.count - a.count;
  });
  return out;
}

function aggregateCities(rows: ReviewRow[]): CityAgg[] {
  const byCity = new Map<
    string,
    { name: string; sum: number; count: number; managers: Set<string> }
  >();
  for (const r of rows) {
    const city = (r.city ?? "").trim();
    if (!city) continue;
    const rating = Number(r.starRating);
    if (Number.isNaN(rating)) continue;
    let c = byCity.get(city);
    if (!c) {
      c = { name: city, sum: 0, count: 0, managers: new Set() };
      byCity.set(city, c);
    }
    c.sum += rating;
    c.count += 1;
    const mgr = (r.managerFirstName ?? "").trim();
    if (mgr) c.managers.add(mgr);
  }
  return [...byCity.values()]
    .map((c) => ({
      name: c.name,
      sum: c.sum,
      count: c.count,
      managerCount: c.managers.size,
      avg: c.count > 0 ? c.sum / c.count : 0,
    }))
    .sort((a, b) => b.avg - a.avg);
}

function aggregateYtdByMonth(
  ytdRows: ReviewRow[],
  currentMonthIdx: number,
  isPartialCurrent: boolean,
): { months: MonthBucket[]; ytdAvg: number; ytdCount: number } {
  const data: Record<number, { sum: number; count: number }> = {};
  let ytdSum = 0;
  let ytdCount = 0;
  for (const r of ytdRows) {
    const rating = Number(r.starRating);
    if (Number.isNaN(rating)) continue;
    const m = r.startDate.getMonth();
    if (!data[m]) data[m] = { sum: 0, count: 0 };
    data[m].sum += rating;
    data[m].count += 1;
    ytdSum += rating;
    ytdCount += 1;
  }
  const months: MonthBucket[] = [];
  for (let m = 0; m <= currentMonthIdx; m++) {
    const d = data[m] ?? { sum: 0, count: 0 };
    months.push({
      idx: m,
      name: MONTH_SHORT[m],
      avg: d.count > 0 ? d.sum / d.count : 0,
      count: d.count,
      partial: m === currentMonthIdx && isPartialCurrent,
    });
  }
  return {
    months,
    ytdAvg: ytdCount > 0 ? ytdSum / ytdCount : 0,
    ytdCount,
  };
}

// -----------------------------------------------------------------
// Component
// -----------------------------------------------------------------

export default function ManagerOfTheMonth({ rows }: { rows: ReviewRow[] }) {
  // Available months come from the data, capped at the current real
  // month. Past months render as "final" (no pacing); current month
  // renders with pacing. Default = current month if it has any rows,
  // else the latest month with data.
  const { availableMonths, defaultKey } = useMemo(() => {
    const present = new Set<string>();
    for (const r of rows) {
      const k = `${r.startDate.getFullYear()}-${String(r.startDate.getMonth()).padStart(2, "0")}`;
      present.add(k);
    }
    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
    // Always include the current month, even if it has no data yet,
    // so the tab is visible. Sort newest first.
    present.add(currentKey);
    const sorted = [...present]
      .map((k) => {
        const [y, m] = k.split("-").map(Number);
        return { key: k, year: y, month: m };
      })
      .sort((a, b) => b.year - a.year || b.month - a.month);
    const def = present.has(currentKey) ? currentKey : (sorted[0]?.key ?? currentKey);
    return { availableMonths: sorted, defaultKey: def };
  }, [rows]);

  const [activeKey, setActiveKey] = useState<string>(defaultKey);
  const [active, setActive] = useState<{ year: number; month: number }>(() => {
    const [y, m] = defaultKey.split("-").map(Number);
    return { year: y, month: m };
  });
  useEffect(() => {
    const [y, m] = activeKey.split("-").map(Number);
    setActive({ year: y, month: m });
  }, [activeKey]);

  const view = useMemo(() => {
    return computeView(rows, active.year, active.month);
  }, [rows, active]);

  // Image export. Dynamic-import keeps html2canvas out of the
  // initial bundle for users who never click the button.
  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    if (!exportRef.current) return;
    setExporting(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(exportRef.current, {
        backgroundColor: "#0a1a10",
        scale: 2,
        useCORS: true,
      });
      const link = document.createElement("a");
      link.download = `matchday-mgr-of-month-${MONTH_SHORT[active.month].toLowerCase()}-${active.year}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch (e) {
      console.warn("Image export failed:", e);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      {/* Google Fonts — React 19 hoists <link> to <head> and dedupes. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,800;1,9..144,400&family=JetBrains+Mono:wght@400;600;700&display=swap"
      />
      <style>{LEADERBOARD_CSS}</style>

      <div className="manager-leaderboard">
        <div className="mlb-month-tabs">
          {availableMonths.map((m) => {
            const label = `${MONTH_SHORT[m.month]} ${m.year}`;
            const isActive = m.key === activeKey;
            return (
              <button
                key={m.key}
                type="button"
                className={`mlb-month-tab${isActive ? " active" : ""}`}
                onClick={() => setActiveKey(m.key)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div ref={exportRef} className="mlb-canvas">
          <header className="mlb-masthead">
            <div>
              <div className="mlb-brand">MatchDay · Manager of the Month</div>
              <h1 className="mlb-h1">
                {MONTH_LONG[active.month]} <span className="mlb-accent">Leaderboard</span>
              </h1>
            </div>
            <div className="mlb-meta-block">
              <div>{view.dateRange}</div>
              <div>
                <strong>{view.daysRemaining}</strong> days remaining
              </div>
              <div>{view.progressLabel}</div>
            </div>
          </header>

          <div className="mlb-status-bar">
            <Stat label="Total Reviews" value={view.totalReviews.toLocaleString()} />
            <Stat
              label="Qualified"
              value={String(view.qualifiedCount)}
              tone="green"
            />
            <Stat
              label="On Pace"
              value={String(view.onPaceCount)}
              tone="blue"
            />
            <Stat
              label="Pace Threshold"
              value={String(view.paceThreshold)}
              tone="gold"
            />
          </div>

          <section className="mlb-company-section">
            <div className="mlb-section-label">Company · Year to Date</div>
            <div className="mlb-company-summary">
              <div className="mlb-company-totals">
                <div className="mlb-totals-label">Average Rating · YTD</div>
                <div className="mlb-totals-rating">
                  <span className="mlb-totals-num">
                    {view.ytdAvg > 0 ? view.ytdAvg.toFixed(2) : "—"}
                  </span>
                  <span className="mlb-totals-of">/ 5.00</span>
                </div>
                <div className="mlb-totals-count">
                  <strong>{view.ytdCount.toLocaleString()}</strong> total reviews across{" "}
                  <span>{view.ytdMonths.length}</span> months
                </div>
              </div>
              <div className="mlb-monthly-chart">
                <div className="mlb-chart-label">
                  Monthly Trend
                  <span className="mlb-chart-scale">▲ partial month</span>
                </div>
                <div className="mlb-month-bars">
                  {(() => {
                    const maxCount = Math.max(1, ...view.ytdMonths.map((m) => m.count));
                    return view.ytdMonths.map((m, i) => (
                      <div
                        key={m.idx}
                        className={`mlb-month-bar${m.partial ? " partial" : ""}`}
                      >
                        <div className="mlb-bar-rating">
                          {m.avg > 0 ? m.avg.toFixed(2) : "—"}
                        </div>
                        <div className="mlb-bar-stack">
                          <div
                            className="mlb-bar-fill"
                            style={{
                              height: `${(m.count / maxCount) * 100}%`,
                              animationDelay: `${i * 0.1}s`,
                            }}
                          />
                        </div>
                        <div className="mlb-bar-label">{m.name}</div>
                        <div className="mlb-bar-count">{m.count.toLocaleString()}</div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>
          </section>

          {view.top3.length > 0 && (
            <section className="mlb-podium-section">
              <div className="mlb-section-label">The Podium</div>
              <div className="mlb-podium">
                {/* Visual order: 2nd, 1st, 3rd to give 1st center prominence */}
                {view.top3[1] && (
                  <PodiumCard
                    m={view.top3[1]}
                    rank={2}
                    cls="second"
                    medal="🥈"
                    isEndOfMonth={view.isEndOfMonth}
                  />
                )}
                {view.top3[0] && (
                  <PodiumCard
                    m={view.top3[0]}
                    rank={1}
                    cls="first"
                    medal="🥇"
                    isEndOfMonth={view.isEndOfMonth}
                  />
                )}
                {view.top3[2] && (
                  <PodiumCard
                    m={view.top3[2]}
                    rank={3}
                    cls="third"
                    medal="🥉"
                    isEndOfMonth={view.isEndOfMonth}
                  />
                )}
              </div>
            </section>
          )}

          {view.cities.length > 0 && (
            <section className="mlb-cities-section">
              <div className="mlb-section-label">By City</div>
              <div className="mlb-cities-grid">
                {view.cities.map((c, idx) => {
                  const fillPct = Math.max(
                    0,
                    Math.min(100, ((c.avg - 4.0) / 1.0) * 100),
                  );
                  return (
                    <div
                      key={c.name}
                      className={`mlb-city-card${idx === 0 ? " top" : ""}`}
                      style={{ animationDelay: `${idx * 0.06}s` }}
                    >
                      <div className="mlb-city-rank">#{idx + 1}</div>
                      <div className="mlb-city-name">{c.name}</div>
                      <div className="mlb-city-rating">
                        <span className="mlb-city-rating-num">{c.avg.toFixed(2)}</span>
                        <span className="mlb-city-rating-of">/ 5.00</span>
                      </div>
                      <div className="mlb-rating-bar">
                        <div className="mlb-rating-bar-fill" style={{ width: `${fillPct}%` }} />
                      </div>
                      <div className="mlb-city-meta">
                        <strong>{c.count.toLocaleString()}</strong> reviews ·{" "}
                        <strong>{c.managerCount}</strong> manager
                        {c.managerCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div className="mlb-table-wrap">
            <div className="mlb-section-label">Full Standings</div>
            <div className="mlb-leaderboard">
              <div className="mlb-row mlb-row-header">
                <div>Rank</div>
                <div>Manager</div>
                <div className="mlb-city-col">City</div>
                <div>Avg Rating</div>
                <div className="mlb-count-col">Reviews</div>
                <div className="mlb-status-col">Status</div>
              </div>
              {(() => {
                let visibleRank = 0;
                return view.managers.map((m, idx) => {
                  const cls = m.qualified
                    ? "qualified"
                    : m.onPace
                      ? "on-pace"
                      : "off-pace";
                  let rankCell;
                  let badge;
                  if (m.qualified) {
                    visibleRank++;
                    rankCell = (
                      <div className="mlb-rank-cell">{visibleRank}</div>
                    );
                    badge = (
                      <span className="mlb-badge mlb-badge-qualified">
                        {view.isEndOfMonth ? "Final" : "Qualified"}
                      </span>
                    );
                  } else if (m.onPace) {
                    visibleRank++;
                    rankCell = (
                      <div className="mlb-rank-cell">{visibleRank}</div>
                    );
                    badge = (
                      <span className="mlb-badge mlb-badge-onpace">
                        On Pace · {Math.round(m.projected)} proj
                      </span>
                    );
                  } else {
                    rankCell = (
                      <div className="mlb-rank-cell muted">—</div>
                    );
                    badge = (
                      <span className="mlb-badge mlb-badge-offpace">Off Pace</span>
                    );
                  }
                  const progressPct = Math.min(
                    100,
                    (m.count / MINIMUM_REVIEWS) * 100,
                  );
                  return (
                    <div
                      key={m.name}
                      className={`mlb-row mlb-${cls}`}
                      style={{
                        animationDelay: `${Math.min(idx * 0.02, 0.6)}s`,
                      }}
                    >
                      {rankCell}
                      <div className="mlb-name-cell">
                        {m.name}
                        <span className="mlb-mobile-city">{m.city}</span>
                      </div>
                      <div className="mlb-city-cell">{m.city}</div>
                      <div className="mlb-rating-cell">{m.avg.toFixed(2)}</div>
                      <div className="mlb-count-cell">
                        {m.count}
                        {!m.qualified && (
                          <span className="mlb-progress">
                            <span
                              className="mlb-progress-fill"
                              style={{ width: `${progressPct}%` }}
                            />
                          </span>
                        )}
                      </div>
                      <div className="mlb-status-cell">{badge}</div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <div className="mlb-footer-note">
            <div className="mlb-legend">
              <div className="mlb-legend-item">
                <span
                  className="mlb-legend-dot"
                  style={{ background: "var(--mlb-green-bright)" }}
                />
                Qualified (50+ reviews)
              </div>
              <div className="mlb-legend-item">
                <span
                  className="mlb-legend-dot"
                  style={{ background: "var(--mlb-on-pace)" }}
                />
                On Pace
              </div>
              <div className="mlb-legend-item">
                <span
                  className="mlb-legend-dot"
                  style={{ background: "rgba(245,239,224,0.2)" }}
                />
                Off Pace
              </div>
            </div>
            <div>
              Rankings by average star rating among qualified managers. Ties
              broken by review count. Pace = (reviews ÷ days elapsed) × days
              in month ≥ 50.
            </div>
          </div>
        </div>

        <div className="mlb-actions">
          <button
            type="button"
            className="mlb-btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? "Rendering…" : "Download as image"}
          </button>
        </div>
      </div>
    </>
  );
}

// -----------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "green" | "blue" | "gold";
}) {
  const toneCls = tone ? ` mlb-tone-${tone}` : "";
  return (
    <div className="mlb-stat">
      <div className="mlb-stat-label">{label}</div>
      <div className={`mlb-stat-value${toneCls}`}>{value}</div>
    </div>
  );
}

function PodiumCard({
  m,
  rank,
  cls,
  medal,
  isEndOfMonth,
}: {
  m: ManagerAgg;
  rank: number;
  cls: "first" | "second" | "third";
  medal: string;
  isEndOfMonth: boolean;
}) {
  const status = m.qualified
    ? isEndOfMonth
      ? "WINNER"
      : "QUALIFIED"
    : "ON PACE";
  const projection = !m.qualified
    ? ` · proj. ${Math.round(m.projected)}`
    : "";
  return (
    <div className={`mlb-podium-card mlb-${cls}`}>
      <div className="mlb-rank-chip">{rank}</div>
      <div className="mlb-medal-icon">{medal}</div>
      <div className="mlb-podium-name">{m.name}</div>
      <div className="mlb-city-tag">{m.city}</div>
      <div className="mlb-rating-row">
        <span className="mlb-rating-big">{m.avg.toFixed(2)}</span>
        <span className="mlb-rating-star">/ 5.00</span>
      </div>
      <div className="mlb-count-line">
        <strong>{m.count}</strong> reviews{projection} · {status}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// View computation — wraps the aggregation pipeline plus all the
// header/meta-text strings the JSX renders. Keeps the JSX tidy.
// -----------------------------------------------------------------

function computeView(rows: ReviewRow[], year: number, month: number) {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // For the active month, "today" = real today if user picked the
  // current calendar month, else daysInMonth (treat past months as
  // end-of-month for pacing purposes).
  const now = new Date();
  const isCurrentMonth =
    year === now.getFullYear() && month === now.getMonth();
  const today = isCurrentMonth ? now.getDate() : daysInMonth;
  const isEndOfMonth = today >= daysInMonth;

  const monthRows = rows.filter(
    (r) => r.startDate >= monthStart && r.startDate < monthEnd,
  );
  const managers = aggregateManagers(monthRows, today, daysInMonth);
  const cities = aggregateCities(monthRows);
  const eligible = managers.filter((m) => m.qualified || m.onPace);
  const top3 = eligible.slice(0, 3);

  const paceThreshold = isEndOfMonth
    ? MINIMUM_REVIEWS
    : Math.ceil((today / daysInMonth) * MINIMUM_REVIEWS);
  const qualifiedCount = managers.filter((m) => m.qualified).length;
  const onPaceCount = managers.filter((m) => m.onPace).length;

  // YTD = Jan 1 of selected year through end of selected month
  const ytdStart = new Date(year, 0, 1);
  const ytdRows = rows.filter(
    (r) => r.startDate >= ytdStart && r.startDate < monthEnd,
  );
  const { months: ytdMonths, ytdAvg, ytdCount } = aggregateYtdByMonth(
    ytdRows,
    month,
    !isEndOfMonth,
  );

  const dateRange = `${MONTH_LONG[month]} 1 – ${today}, ${year}`;
  const daysRemaining = isEndOfMonth ? 0 : daysInMonth - today;
  const progressLabel = `${Math.round((today / daysInMonth) * 100)}% of month elapsed`;

  return {
    managers,
    cities,
    top3,
    totalReviews: monthRows.length,
    qualifiedCount,
    onPaceCount,
    paceThreshold,
    ytdMonths,
    ytdAvg,
    ytdCount,
    dateRange,
    daysRemaining,
    progressLabel,
    isEndOfMonth,
  };
}

// -----------------------------------------------------------------
// CSS — every selector scoped under .manager-leaderboard. CSS custom
// properties hang off that root so they cascade only inside this
// container. Keyframes are mlb-prefixed (global by name) to avoid
// collision with anything else in the app.
// -----------------------------------------------------------------

const LEADERBOARD_CSS = `
.manager-leaderboard {
  --mlb-bg: #0a1a10;
  --mlb-bg-2: #0f2419;
  --mlb-paper: #f5efe0;
  --mlb-ink: #0a1a10;
  --mlb-green-bright: #1dd67a;
  --mlb-gold-bright: #f5c542;
  --mlb-on-pace: #4ea8ff;
  --mlb-muted: #7a8478;
  --mlb-danger: #d94a3d;
  background:
    radial-gradient(ellipse at top left, rgba(29, 214, 122, 0.08), transparent 50%),
    radial-gradient(ellipse at bottom right, rgba(212, 160, 23, 0.06), transparent 50%),
    linear-gradient(180deg, var(--mlb-bg) 0%, var(--mlb-bg-2) 100%);
  color: var(--mlb-paper);
  font-family: 'Fraunces', Georgia, serif;
  border-radius: 16px;
  padding: 32px;
  margin: 0 auto;
  position: relative;
  overflow: hidden;
}

.manager-leaderboard *,
.manager-leaderboard *::before,
.manager-leaderboard *::after {
  box-sizing: border-box;
}

.manager-leaderboard .mlb-canvas {
  position: relative;
  z-index: 1;
}

/* Month tabs */
.manager-leaderboard .mlb-month-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(245, 239, 224, 0.1);
}
.manager-leaderboard .mlb-month-tab {
  padding: 8px 16px;
  background: transparent;
  color: var(--mlb-muted);
  border: 1px solid rgba(245, 239, 224, 0.15);
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.2s;
}
.manager-leaderboard .mlb-month-tab:hover {
  color: var(--mlb-paper);
  border-color: rgba(245, 239, 224, 0.4);
}
.manager-leaderboard .mlb-month-tab.active {
  background: var(--mlb-green-bright);
  color: var(--mlb-bg);
  border-color: var(--mlb-green-bright);
}

/* Masthead */
.manager-leaderboard .mlb-masthead {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid rgba(245, 239, 224, 0.1);
  margin-bottom: 32px;
}
.manager-leaderboard .mlb-brand {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  letter-spacing: 0.3em;
  color: var(--mlb-green-bright);
  text-transform: uppercase;
  margin-bottom: 12px;
}
.manager-leaderboard .mlb-brand::before {
  content: "●";
  margin-right: 8px;
  animation: mlb-pulse 2s infinite;
}
@keyframes mlb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.manager-leaderboard .mlb-h1 {
  font-family: 'Bebas Neue', sans-serif;
  font-size: clamp(2.4rem, 6vw, 4.8rem);
  line-height: 0.95;
  letter-spacing: -0.01em;
  color: var(--mlb-paper);
  font-weight: 400;
  margin: 0;
}
.manager-leaderboard .mlb-accent {
  color: var(--mlb-gold-bright);
  font-style: italic;
  font-family: 'Fraunces', serif;
  font-weight: 800;
}
.manager-leaderboard .mlb-meta-block {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--mlb-muted);
  line-height: 1.8;
}
.manager-leaderboard .mlb-meta-block strong {
  color: var(--mlb-paper);
  font-size: 1.1rem;
}

/* Status bar */
.manager-leaderboard .mlb-status-bar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: rgba(245, 239, 224, 0.08);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 48px;
}
.manager-leaderboard .mlb-stat {
  padding: 20px 24px;
  background: rgba(15, 36, 25, 0.85);
}
.manager-leaderboard .mlb-stat-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.68rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  margin-bottom: 8px;
}
.manager-leaderboard .mlb-stat-value {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 2.2rem;
  color: var(--mlb-paper);
  letter-spacing: 0.02em;
  line-height: 1;
}
.manager-leaderboard .mlb-stat-value.mlb-tone-green { color: var(--mlb-green-bright); }
.manager-leaderboard .mlb-stat-value.mlb-tone-gold { color: var(--mlb-gold-bright); }
.manager-leaderboard .mlb-stat-value.mlb-tone-blue { color: var(--mlb-on-pace); }

/* Section labels */
.manager-leaderboard .mlb-section-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.manager-leaderboard .mlb-section-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(245, 239, 224, 0.2), transparent);
}

/* Company / monthly trend */
.manager-leaderboard .mlb-company-section {
  margin-bottom: 48px;
}
.manager-leaderboard .mlb-company-summary {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 24px;
  align-items: stretch;
}
.manager-leaderboard .mlb-company-totals {
  background: linear-gradient(160deg, rgba(29, 214, 122, 0.08), rgba(212, 160, 23, 0.04));
  border: 1px solid rgba(245, 239, 224, 0.1);
  border-radius: 12px;
  padding: 28px 28px 24px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.manager-leaderboard .mlb-totals-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  margin-bottom: 14px;
}
.manager-leaderboard .mlb-totals-rating {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.manager-leaderboard .mlb-totals-num {
  font-family: 'Fraunces', serif;
  font-weight: 800;
  font-size: 4.2rem;
  line-height: 1;
  color: var(--mlb-gold-bright);
  letter-spacing: -0.03em;
}
.manager-leaderboard .mlb-totals-of {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  color: var(--mlb-muted);
}
.manager-leaderboard .mlb-totals-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  color: var(--mlb-paper);
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(245, 239, 224, 0.1);
}
.manager-leaderboard .mlb-totals-count strong {
  color: var(--mlb-green-bright);
  font-weight: 700;
}
.manager-leaderboard .mlb-monthly-chart {
  background: rgba(245, 239, 224, 0.03);
  border: 1px solid rgba(245, 239, 224, 0.08);
  border-radius: 12px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
}
.manager-leaderboard .mlb-chart-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  margin-bottom: 20px;
}
.manager-leaderboard .mlb-chart-scale {
  float: right;
  color: var(--mlb-muted);
  text-transform: none;
  letter-spacing: 0.05em;
  font-size: 0.65rem;
}
.manager-leaderboard .mlb-month-bars {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 14px;
  flex: 1;
  align-items: end;
  min-height: 180px;
}
.manager-leaderboard .mlb-month-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  position: relative;
}
.manager-leaderboard .mlb-bar-rating {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--mlb-gold-bright);
  margin-bottom: 2px;
}
.manager-leaderboard .mlb-bar-stack {
  width: 100%;
  max-width: 56px;
  background: rgba(245, 239, 224, 0.06);
  border-radius: 6px 6px 0 0;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 140px;
}
.manager-leaderboard .mlb-bar-fill {
  width: 100%;
  background: linear-gradient(180deg, var(--mlb-gold-bright), var(--mlb-green-bright));
  border-radius: 6px 6px 0 0;
  transition: height 1.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  animation: mlb-barGrow 1.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes mlb-barGrow {
  from { height: 0 !important; }
}
.manager-leaderboard .mlb-month-bar.partial .mlb-bar-fill {
  background: repeating-linear-gradient(
    135deg,
    var(--mlb-on-pace),
    var(--mlb-on-pace) 6px,
    rgba(78, 168, 255, 0.6) 6px,
    rgba(78, 168, 255, 0.6) 12px
  );
}
.manager-leaderboard .mlb-month-bar.partial .mlb-bar-rating {
  color: var(--mlb-on-pace);
}
.manager-leaderboard .mlb-bar-label {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 1.05rem;
  letter-spacing: 0.06em;
  color: var(--mlb-paper);
}
.manager-leaderboard .mlb-bar-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  color: var(--mlb-muted);
}
.manager-leaderboard .mlb-month-bar.partial .mlb-bar-label::after {
  content: " ▲";
  color: var(--mlb-on-pace);
  font-size: 0.7em;
  vertical-align: super;
}

/* Podium */
.manager-leaderboard .mlb-podium-section {
  margin-bottom: 48px;
}
.manager-leaderboard .mlb-podium {
  display: grid;
  grid-template-columns: 1fr 1.15fr 1fr;
  gap: 20px;
  align-items: end;
}
.manager-leaderboard .mlb-podium-card {
  position: relative;
  padding: 28px 24px 32px;
  border-radius: 12px;
  background: var(--mlb-paper);
  color: var(--mlb-ink);
  overflow: hidden;
  transition: transform 0.3s ease;
  animation: mlb-rise 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.manager-leaderboard .mlb-podium-card:hover {
  transform: translateY(-4px);
}
@keyframes mlb-rise {
  from { opacity: 0; transform: translateY(40px); }
  to { opacity: 1; transform: translateY(0); }
}
.manager-leaderboard .mlb-podium-card.mlb-first {
  background: linear-gradient(180deg, #fef4d6 0%, #f5c542 100%);
  padding-top: 48px;
  padding-bottom: 40px;
  animation-delay: 0.3s;
  box-shadow: 0 20px 60px rgba(212, 160, 23, 0.25);
}
.manager-leaderboard .mlb-podium-card.mlb-second {
  background: linear-gradient(180deg, #f0f2f5 0%, #c0c5cc 100%);
  animation-delay: 0.15s;
  box-shadow: 0 16px 40px rgba(192, 197, 204, 0.2);
}
.manager-leaderboard .mlb-podium-card.mlb-third {
  background: linear-gradient(180deg, #f0d9bd 0%, #b86b2f 100%);
  animation-delay: 0s;
  box-shadow: 0 16px 40px rgba(184, 107, 47, 0.2);
}
.manager-leaderboard .mlb-rank-chip {
  position: absolute;
  top: -18px;
  left: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--mlb-bg);
  color: var(--mlb-paper);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Bebas Neue', sans-serif;
  font-size: 1.8rem;
  letter-spacing: 0.04em;
  border: 3px solid var(--mlb-paper);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.manager-leaderboard .mlb-first .mlb-rank-chip { background: #1a1207; color: var(--mlb-gold-bright); }
.manager-leaderboard .mlb-second .mlb-rank-chip { background: #1a1d20; color: #e8ecef; }
.manager-leaderboard .mlb-third .mlb-rank-chip { background: #2a1810; color: #f0d9bd; }
.manager-leaderboard .mlb-medal-icon {
  position: absolute;
  top: 20px;
  right: 20px;
  font-size: 2.2rem;
  opacity: 0.85;
}
.manager-leaderboard .mlb-podium-name {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 2.6rem;
  line-height: 1;
  letter-spacing: 0.01em;
  margin-top: 16px;
  margin-bottom: 4px;
  color: var(--mlb-ink);
  word-break: break-word;
}
.manager-leaderboard .mlb-first .mlb-podium-name { font-size: 3.2rem; }
.manager-leaderboard .mlb-city-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(10, 26, 16, 0.6);
  margin-top: 6px;
}
.manager-leaderboard .mlb-city-tag::before {
  content: "▸ ";
  color: rgba(10, 26, 16, 0.4);
}
.manager-leaderboard .mlb-rating-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid rgba(10, 26, 16, 0.15);
}
.manager-leaderboard .mlb-rating-big {
  font-family: 'Fraunces', serif;
  font-weight: 800;
  font-size: 3.2rem;
  line-height: 1;
  color: var(--mlb-ink);
  letter-spacing: -0.02em;
}
.manager-leaderboard .mlb-first .mlb-rating-big { font-size: 3.8rem; }
.manager-leaderboard .mlb-rating-star {
  color: var(--mlb-ink);
  opacity: 0.5;
  font-size: 1rem;
}
.manager-leaderboard .mlb-count-line {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(10, 26, 16, 0.65);
  margin-top: 8px;
}
.manager-leaderboard .mlb-count-line strong {
  color: var(--mlb-ink);
  font-weight: 700;
}

/* Cities */
.manager-leaderboard .mlb-cities-section {
  margin-bottom: 48px;
}
.manager-leaderboard .mlb-cities-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.manager-leaderboard .mlb-city-card {
  background: rgba(245, 239, 224, 0.04);
  border: 1px solid rgba(245, 239, 224, 0.08);
  border-radius: 10px;
  padding: 22px 22px 20px;
  position: relative;
  overflow: hidden;
  transition: all 0.25s ease;
  animation: mlb-rise 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.manager-leaderboard .mlb-city-card:hover {
  background: rgba(245, 239, 224, 0.06);
  border-color: rgba(29, 214, 122, 0.3);
  transform: translateY(-2px);
}
.manager-leaderboard .mlb-city-rank {
  position: absolute;
  top: 18px;
  right: 18px;
  font-family: 'Bebas Neue', sans-serif;
  font-size: 0.95rem;
  color: var(--mlb-muted);
  letter-spacing: 0.05em;
}
.manager-leaderboard .mlb-city-card.top .mlb-city-rank { color: var(--mlb-gold-bright); }
.manager-leaderboard .mlb-city-name {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 1.6rem;
  color: var(--mlb-paper);
  letter-spacing: 0.02em;
  line-height: 1.05;
  margin-bottom: 16px;
  padding-right: 36px;
}
.manager-leaderboard .mlb-city-rating {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 10px;
}
.manager-leaderboard .mlb-city-rating-num {
  font-family: 'Fraunces', serif;
  font-weight: 800;
  font-size: 2.2rem;
  line-height: 1;
  color: var(--mlb-gold-bright);
  letter-spacing: -0.02em;
}
.manager-leaderboard .mlb-city-rating-of {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--mlb-muted);
}
.manager-leaderboard .mlb-city-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  padding-top: 12px;
  margin-top: 10px;
  border-top: 1px solid rgba(245, 239, 224, 0.08);
  line-height: 1.7;
}
.manager-leaderboard .mlb-city-meta strong {
  color: var(--mlb-paper);
  font-weight: 700;
}
.manager-leaderboard .mlb-rating-bar {
  height: 3px;
  background: rgba(245, 239, 224, 0.08);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 8px;
}
.manager-leaderboard .mlb-rating-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--mlb-green-bright), var(--mlb-gold-bright));
  border-radius: 2px;
  transition: width 1s ease;
}

/* Full standings table */
.manager-leaderboard .mlb-table-wrap {
  margin-bottom: 32px;
}
.manager-leaderboard .mlb-leaderboard {
  background: rgba(245, 239, 224, 0.03);
  border: 1px solid rgba(245, 239, 224, 0.08);
  border-radius: 12px;
  overflow: hidden;
}
.manager-leaderboard .mlb-row {
  display: grid;
  grid-template-columns: 60px 1fr 110px 110px 110px 150px;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid rgba(245, 239, 224, 0.06);
  transition: background 0.2s ease;
  animation: mlb-fadeIn 0.5s ease both;
}
@keyframes mlb-fadeIn {
  from { opacity: 0; transform: translateX(-12px); }
  to { opacity: 1; transform: translateX(0); }
}
.manager-leaderboard .mlb-row:last-child { border-bottom: none; }
.manager-leaderboard .mlb-row:hover { background: rgba(245, 239, 224, 0.04); }
.manager-leaderboard .mlb-row-header {
  background: rgba(10, 26, 16, 0.6);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--mlb-muted);
  padding: 14px 24px;
}
.manager-leaderboard .mlb-row-header:hover { background: rgba(10, 26, 16, 0.6); }
.manager-leaderboard .mlb-qualified { border-left: 3px solid var(--mlb-green-bright); padding-left: 21px; }
.manager-leaderboard .mlb-on-pace { border-left: 3px solid var(--mlb-on-pace); padding-left: 21px; }
.manager-leaderboard .mlb-off-pace { border-left: 3px solid transparent; padding-left: 21px; opacity: 0.55; }
.manager-leaderboard .mlb-rank-cell {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 1.5rem;
  color: var(--mlb-paper);
  letter-spacing: 0.02em;
}
.manager-leaderboard .mlb-rank-cell.muted { color: var(--mlb-muted); }
.manager-leaderboard .mlb-name-cell {
  font-family: 'Fraunces', serif;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--mlb-paper);
}
.manager-leaderboard .mlb-rating-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--mlb-gold-bright);
}
.manager-leaderboard .mlb-count-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.95rem;
  color: var(--mlb-paper);
}
.manager-leaderboard .mlb-city-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--mlb-muted);
}
.manager-leaderboard .mlb-status-cell {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 700;
}
.manager-leaderboard .mlb-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
}
.manager-leaderboard .mlb-badge-qualified {
  background: rgba(29, 214, 122, 0.15);
  color: var(--mlb-green-bright);
  border: 1px solid rgba(29, 214, 122, 0.3);
}
.manager-leaderboard .mlb-badge-onpace {
  background: rgba(78, 168, 255, 0.12);
  color: var(--mlb-on-pace);
  border: 1px solid rgba(78, 168, 255, 0.3);
}
.manager-leaderboard .mlb-badge-offpace {
  background: rgba(245, 239, 224, 0.04);
  color: var(--mlb-muted);
  border: 1px solid rgba(245, 239, 224, 0.1);
}
.manager-leaderboard .mlb-progress {
  display: inline-block;
  width: 60px;
  height: 4px;
  background: rgba(245, 239, 224, 0.1);
  border-radius: 2px;
  overflow: hidden;
  margin-left: 8px;
  vertical-align: middle;
}
.manager-leaderboard .mlb-progress-fill {
  height: 100%;
  background: var(--mlb-on-pace);
  border-radius: 2px;
}
.manager-leaderboard .mlb-qualified .mlb-progress-fill { background: var(--mlb-green-bright); }
.manager-leaderboard .mlb-mobile-city { display: none; }

/* Footer + actions */
.manager-leaderboard .mlb-footer-note {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--mlb-muted);
  text-align: center;
  padding-top: 32px;
  border-top: 1px solid rgba(245, 239, 224, 0.08);
  line-height: 1.8;
}
.manager-leaderboard .mlb-legend {
  display: flex;
  justify-content: center;
  gap: 32px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.manager-leaderboard .mlb-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.manager-leaderboard .mlb-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.manager-leaderboard .mlb-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}
.manager-leaderboard .mlb-btn {
  padding: 10px 20px;
  background: transparent;
  color: var(--mlb-paper);
  border: 1px solid rgba(245, 239, 224, 0.2);
  border-radius: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.2s;
}
.manager-leaderboard .mlb-btn:hover {
  background: rgba(245, 239, 224, 0.08);
  border-color: var(--mlb-paper);
}
.manager-leaderboard .mlb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 800px) {
  .manager-leaderboard { padding: 20px; }
  .manager-leaderboard .mlb-podium { grid-template-columns: 1fr; gap: 16px; }
  .manager-leaderboard .mlb-company-summary { grid-template-columns: 1fr; }
  .manager-leaderboard .mlb-month-bars { gap: 8px; }
  .manager-leaderboard .mlb-bar-stack { height: 110px; }
  .manager-leaderboard .mlb-row {
    grid-template-columns: 36px 1fr 60px 50px;
    font-size: 0.88rem;
    padding: 12px 14px;
    gap: 6px;
  }
  .manager-leaderboard .mlb-status-cell,
  .manager-leaderboard .mlb-city-cell { display: none; }
  .manager-leaderboard .mlb-progress { display: none; }
  .manager-leaderboard .mlb-name-cell { font-size: 1rem; }
  .manager-leaderboard .mlb-mobile-city {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--mlb-muted);
    margin-top: 2px;
  }
  .manager-leaderboard .mlb-status-bar { grid-template-columns: repeat(2, 1fr); }
  .manager-leaderboard .mlb-h1 { font-size: 2.4rem; }
  .manager-leaderboard .mlb-masthead { grid-template-columns: 1fr; }
  .manager-leaderboard .mlb-meta-block { text-align: left; }
}
`;
