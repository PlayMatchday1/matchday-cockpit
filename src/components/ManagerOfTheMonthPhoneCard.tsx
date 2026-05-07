"use client";

// Phone-format Manager of the Month card. Renders into a hidden,
// offscreen 800px-wide div from ManagerOfTheMonth so html-to-image
// can capture it as a PNG for WhatsApp distribution. The desktop
// dashboard renders ManagerOfTheMonth.tsx; this file only exists for
// the export path.
//
// All CSS lives inside a <style> element that's a child of the
// captured div, so html-to-image's clone (foreignObject SVG)
// includes the styles. Selectors are pc- prefixed to avoid colliding
// with the dashboard's mlb- scope.

import { forwardRef } from "react";

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type ManagerAgg = {
  name: string;
  city: string;
  avg: number;
  count: number;
  qualified: boolean;
  onPace: boolean;
  offPace: boolean;
  projected: number;
};

type CityAgg = {
  name: string;
  count: number;
  managerCount: number;
  avg: number;
};

export type PhoneCardView = {
  managers: ManagerAgg[];
  cities: CityAgg[];
  top3: ManagerAgg[];
  totalReviews: number;
  dateRange: string;
  isEndOfMonth: boolean;
};

const PHONE_CSS = `
.mlb-phone {
  width: 800px;
  background:
    radial-gradient(ellipse at top left, rgba(29, 214, 122, 0.10), transparent 55%),
    radial-gradient(ellipse at bottom right, rgba(212, 160, 23, 0.08), transparent 55%),
    linear-gradient(180deg, #0a1a10 0%, #0f2419 100%);
  color: #f5efe0;
  font-family: 'Fraunces', Georgia, serif;
  padding: 56px 48px;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
.mlb-phone *, .mlb-phone *::before, .mlb-phone *::after {
  box-sizing: border-box;
}

/* Header */
.mlb-phone .pc-brand {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: #1dd67a;
  margin-bottom: 28px;
}
.mlb-phone .pc-brand::before {
  content: "● ";
}
.mlb-phone .pc-h1 {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 108px;
  line-height: 0.9;
  letter-spacing: -0.01em;
  color: #f5efe0;
  font-weight: 400;
  margin: 0;
}
.mlb-phone .pc-accent {
  display: block;
  font-family: 'Fraunces', serif;
  font-style: italic;
  font-weight: 800;
  font-size: 78px;
  color: #f5c542;
  margin-top: 8px;
}
.mlb-phone .pc-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  color: #f5efe0;
  margin-top: 32px;
  padding-top: 26px;
  border-top: 1px solid rgba(245, 239, 224, 0.1);
}
.mlb-phone .pc-meta strong {
  color: #1dd67a;
  font-weight: 700;
}

/* Section labels */
.mlb-phone .pc-section-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: #7a8478;
  margin-top: 60px;
  margin-bottom: 28px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.mlb-phone .pc-section-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(245, 239, 224, 0.22), transparent);
}

/* Podium */
.mlb-phone .pc-podium {
  display: flex;
  flex-direction: column;
  gap: 36px;
  margin-top: 28px;
}
.mlb-phone .pc-podium-card {
  position: relative;
  padding: 52px 40px 40px;
  border-radius: 18px;
  color: #0a1a10;
}
.mlb-phone .pc-first {
  background: linear-gradient(180deg, #fef4d6 0%, #f5c542 100%);
  padding: 60px 40px 48px;
  box-shadow: 0 24px 60px rgba(212, 160, 23, 0.25);
}
.mlb-phone .pc-second {
  background: linear-gradient(180deg, #f0f2f5 0%, #c0c5cc 100%);
  box-shadow: 0 18px 44px rgba(192, 197, 204, 0.22);
}
.mlb-phone .pc-third {
  background: linear-gradient(180deg, #f0d9bd 0%, #b86b2f 100%);
  box-shadow: 0 18px 44px rgba(184, 107, 47, 0.22);
}
.mlb-phone .pc-rank-chip {
  position: absolute;
  top: -32px;
  left: 36px;
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: #1a1207;
  color: #f5c542;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Bebas Neue', sans-serif;
  font-size: 56px;
  border: 4px solid #f5efe0;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);
}
.mlb-phone .pc-second .pc-rank-chip {
  background: #1a1d20;
  color: #e8ecef;
}
.mlb-phone .pc-third .pc-rank-chip {
  background: #2a1810;
  color: #f0d9bd;
}
.mlb-phone .pc-medal {
  position: absolute;
  top: 28px;
  right: 32px;
  font-size: 64px;
  line-height: 1;
}
.mlb-phone .pc-name {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 64px;
  line-height: 1;
  letter-spacing: 0.01em;
  margin-top: 24px;
  margin-bottom: 4px;
  word-break: break-word;
}
.mlb-phone .pc-first .pc-name {
  font-size: 80px;
}
.mlb-phone .pc-city-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(10, 26, 16, 0.62);
  margin-top: 10px;
}
.mlb-phone .pc-city-tag::before {
  content: "▸ ";
  color: rgba(10, 26, 16, 0.4);
}
.mlb-phone .pc-rating-row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-top: 30px;
  padding-top: 24px;
  border-top: 1px solid rgba(10, 26, 16, 0.18);
}
.mlb-phone .pc-rating-big {
  font-family: 'Fraunces', serif;
  font-weight: 800;
  font-size: 80px;
  line-height: 1;
  letter-spacing: -0.02em;
}
.mlb-phone .pc-first .pc-rating-big {
  font-size: 96px;
}
.mlb-phone .pc-rating-of {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  opacity: 0.55;
}
.mlb-phone .pc-count-line {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(10, 26, 16, 0.7);
  margin-top: 16px;
}
.mlb-phone .pc-count-line strong {
  color: #0a1a10;
  font-weight: 700;
}

/* Cities */
.mlb-phone .pc-cities-list {
  display: flex;
  flex-direction: column;
  background: rgba(245, 239, 224, 0.025);
  border: 1px solid rgba(245, 239, 224, 0.07);
  border-radius: 14px;
  padding: 8px 24px;
}
.mlb-phone .pc-city-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 26px 0;
  border-bottom: 1px solid rgba(245, 239, 224, 0.08);
}
.mlb-phone .pc-city-row:last-child {
  border-bottom: none;
}
.mlb-phone .pc-city-rank {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 38px;
  width: 72px;
  color: #7a8478;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.mlb-phone .pc-city-row.pc-top .pc-city-rank {
  color: #f5c542;
}
.mlb-phone .pc-city-meta {
  flex: 1;
  min-width: 0;
}
.mlb-phone .pc-city-name-row {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 44px;
  line-height: 1.05;
  color: #f5efe0;
  letter-spacing: 0.02em;
}
.mlb-phone .pc-city-sub {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  letter-spacing: 0.06em;
  color: #7a8478;
  text-transform: uppercase;
  margin-top: 8px;
}
.mlb-phone .pc-city-sub strong {
  color: #f5efe0;
  font-weight: 700;
}
.mlb-phone .pc-city-right {
  text-align: right;
  flex-shrink: 0;
}
.mlb-phone .pc-city-rating {
  font-family: 'Fraunces', serif;
  font-weight: 800;
  font-size: 56px;
  line-height: 1;
  color: #f5c542;
  letter-spacing: -0.02em;
}
.mlb-phone .pc-city-rating-of {
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  color: #7a8478;
  display: block;
  margin-top: 6px;
  letter-spacing: 0.05em;
}

/* Standings */
.mlb-phone .pc-standings {
  display: flex;
  flex-direction: column;
  background: rgba(245, 239, 224, 0.025);
  border: 1px solid rgba(245, 239, 224, 0.07);
  border-radius: 14px;
  overflow: hidden;
}
.mlb-phone .pc-row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 24px 22px;
  border-bottom: 1px solid rgba(245, 239, 224, 0.08);
  border-left: 4px solid transparent;
}
.mlb-phone .pc-row:last-child {
  border-bottom: none;
}
.mlb-phone .pc-row.pc-qualified {
  border-left-color: #1dd67a;
}
.mlb-phone .pc-row.pc-on-pace {
  border-left-color: #4ea8ff;
}
.mlb-phone .pc-row.pc-off-pace {
  border-left-color: rgba(245, 239, 224, 0.18);
  opacity: 0.55;
}
.mlb-phone .pc-row-rank {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 40px;
  color: #f5efe0;
  width: 64px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.mlb-phone .pc-row-main {
  flex: 1;
  min-width: 0;
}
.mlb-phone .pc-row-name {
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 32px;
  line-height: 1.1;
  color: #f5efe0;
  word-break: break-word;
}
.mlb-phone .pc-row-city {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #7a8478;
  margin-top: 6px;
}
.mlb-phone .pc-row-right {
  text-align: right;
  flex-shrink: 0;
}
.mlb-phone .pc-row-rating {
  font-family: 'JetBrains Mono', monospace;
  font-size: 36px;
  font-weight: 700;
  color: #f5c542;
  line-height: 1;
}
.mlb-phone .pc-row-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 20px;
  color: #f5efe0;
  margin-top: 8px;
}
.mlb-phone .pc-row-status {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-top: 6px;
  color: #7a8478;
  font-weight: 700;
}
.mlb-phone .pc-row-status.is-qualified {
  color: #1dd67a;
}
.mlb-phone .pc-row-status.is-on-pace {
  color: #4ea8ff;
}
.mlb-phone .pc-row-status.is-off-pace {
  color: #7a8478;
}

/* Footer */
.mlb-phone .pc-footer {
  margin-top: 60px;
  padding-top: 36px;
  border-top: 1px solid rgba(245, 239, 224, 0.1);
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  color: #7a8478;
  text-align: center;
  line-height: 1.7;
}
.mlb-phone .pc-legend {
  display: flex;
  justify-content: center;
  gap: 32px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.mlb-phone .pc-legend-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mlb-phone .pc-legend-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-block;
}
`;

type PhoneCardProps = {
  view: PhoneCardView;
  month: number;
  year: number;
};

const ManagerOfTheMonthPhoneCard = forwardRef<HTMLDivElement, PhoneCardProps>(
  function ManagerOfTheMonthPhoneCard({ view, month, year }, ref) {
    // Phone-card sort: qualified first (by avg desc), then on-pace
    // (by avg desc), then off-pace (by avg desc). Within each group,
    // review count breaks ties. Differs from the desktop sort, which
    // mixes qualified+on-pace together — phone card groups them
    // visually so the eye lands on qualified first.
    const sortByAvg = (a: ManagerAgg, b: ManagerAgg) =>
      b.avg !== a.avg ? b.avg - a.avg : b.count - a.count;
    const allRanked = [
      ...view.managers.filter((m) => m.qualified).sort(sortByAvg),
      ...view.managers.filter((m) => m.onPace).sort(sortByAvg),
      ...view.managers.filter((m) => m.offPace).sort(sortByAvg),
    ];
    return (
      <div ref={ref} className="mlb-phone">
        <style>{PHONE_CSS}</style>

        <div className="pc-brand">MatchDay · Manager of the Month</div>
        <h1 className="pc-h1">
          {MONTH_LONG[month]} {year}
          <span className="pc-accent">Leaderboard</span>
        </h1>
        <div className="pc-meta">
          <strong>{view.totalReviews.toLocaleString()}</strong> reviews ·{" "}
          {view.dateRange}
        </div>

        {view.top3.length > 0 && (
          <>
            <div className="pc-section-label">The Podium</div>
            <div className="pc-podium">
              {[0, 1, 2].map((i) => {
                const m = view.top3[i];
                if (!m) return null;
                const cls =
                  i === 0 ? "pc-first" : i === 1 ? "pc-second" : "pc-third";
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
                const rank = i + 1;
                const status = m.qualified
                  ? view.isEndOfMonth
                    ? "WINNER"
                    : "QUALIFIED"
                  : "ON PACE";
                const proj = !m.qualified
                  ? ` · proj. ${Math.round(m.projected)}`
                  : "";
                return (
                  <div
                    key={m.name}
                    className={`pc-podium-card ${cls}`}
                  >
                    <div className="pc-rank-chip">{rank}</div>
                    <div className="pc-medal">{medal}</div>
                    <div className="pc-name">{m.name}</div>
                    <div className="pc-city-tag">{m.city}</div>
                    <div className="pc-rating-row">
                      <span className="pc-rating-big">
                        {m.avg.toFixed(2)}
                      </span>
                      <span className="pc-rating-of">/ 5.00</span>
                    </div>
                    <div className="pc-count-line">
                      <strong>{m.count}</strong> reviews{proj} · {status}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view.cities.length > 0 && (
          <>
            <div className="pc-section-label">By City</div>
            <div className="pc-cities-list">
              {view.cities.map((c, idx) => (
                <div
                  key={c.name}
                  className={`pc-city-row${idx === 0 ? " pc-top" : ""}`}
                >
                  <div className="pc-city-rank">#{idx + 1}</div>
                  <div className="pc-city-meta">
                    <div className="pc-city-name-row">{c.name}</div>
                    <div className="pc-city-sub">
                      <strong>{c.count.toLocaleString()}</strong> reviews ·{" "}
                      <strong>{c.managerCount}</strong> manager
                      {c.managerCount === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="pc-city-right">
                    <div className="pc-city-rating">{c.avg.toFixed(2)}</div>
                    <span className="pc-city-rating-of">/ 5.00</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {allRanked.length > 0 && (
          <>
            <div className="pc-section-label">Full Standings</div>
            <div className="pc-standings">
              {(() => {
                let visibleRank = 0;
                return allRanked.map((m) => {
                  let cls: string;
                  let rankDisplay: string;
                  let statusText: string;
                  let statusCls: string;
                  if (m.qualified) {
                    visibleRank += 1;
                    cls = "pc-qualified";
                    rankDisplay = String(visibleRank);
                    statusText = view.isEndOfMonth ? "WINNER" : "QUALIFIED";
                    statusCls = "is-qualified";
                  } else if (m.onPace) {
                    visibleRank += 1;
                    cls = "pc-on-pace";
                    rankDisplay = String(visibleRank);
                    statusText = `ON PACE · ${Math.round(m.projected)} PROJ`;
                    statusCls = "is-on-pace";
                  } else {
                    cls = "pc-off-pace";
                    rankDisplay = "—";
                    statusText = "OFF PACE";
                    statusCls = "is-off-pace";
                  }
                  return (
                    <div key={m.name} className={`pc-row ${cls}`}>
                      <div className="pc-row-rank">{rankDisplay}</div>
                      <div className="pc-row-main">
                        <div className="pc-row-name">{m.name}</div>
                        <div className="pc-row-city">{m.city}</div>
                      </div>
                      <div className="pc-row-right">
                        <div className="pc-row-rating">
                          {m.avg.toFixed(2)}
                        </div>
                        <div className="pc-row-count">{m.count} reviews</div>
                        <div className={`pc-row-status ${statusCls}`}>
                          {statusText}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}

        <div className="pc-footer">
          <div className="pc-legend">
            <span className="pc-legend-item">
              <span
                className="pc-legend-dot"
                style={{ background: "#1dd67a" }}
              />
              Qualified (50+ reviews)
            </span>
            <span className="pc-legend-item">
              <span
                className="pc-legend-dot"
                style={{ background: "#4ea8ff" }}
              />
              On Pace
            </span>
            <span className="pc-legend-item">
              <span
                className="pc-legend-dot"
                style={{ background: "rgba(245, 239, 224, 0.25)" }}
              />
              Off Pace
            </span>
          </div>
          <div>
            Rankings by avg star rating · Ties broken by review count
            <br />
            Pace = projected to 50+ reviews
          </div>
        </div>
      </div>
    );
  },
);

export default ManagerOfTheMonthPhoneCard;
