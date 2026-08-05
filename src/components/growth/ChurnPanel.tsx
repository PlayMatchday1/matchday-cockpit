"use client";

import { useEffect, useState } from "react";
import styles from "./growth.module.css";
import { countLabel, fmtInt } from "./format";

// PART 6: potential churn. Reads /api/growth/churn (growth_player_profile — one
// row per PLAYED player), filtered by city + an inactivity threshold (30/60/90/
// 120 days), server-paginated 100/page. The four bucket counts arrive together
// in one response; the CSV is streamed by the endpoint (never assembled here).
// The buckets are captioned: with data starting Jan 2026, "120 days" means "no
// play since ~April", and a player whose only match was in January reads as
// churned by construction — so 90/120 must not be over-read.
const BUCKETS = [30, 60, 90, 120] as const;
const PAGE_SIZE = 100;

type ChurnRow = { u: number; city: string; field: string; days: number; matches: number; last: string };
type ChurnResponse = {
  days: number;
  page: number;
  pageSize: number;
  total: number;
  counts: Record<string, number>;
  rows: ChurnRow[];
};

export default function ChurnPanel({
  cities,
  authHeaders,
}: {
  cities: string[];
  authHeaders: Record<string, string>;
}) {
  const cityOptions = ["All cities", ...cities];
  const [city, setCity] = useState("All cities");
  const [threshold, setThreshold] = useState<number>(90); // matches the design default
  const [page, setPage] = useState(0);
  const [resp, setResp] = useState<ChurnResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cityParam = city === "All cities" ? "all" : city;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/growth/churn?days=${threshold}&city=${encodeURIComponent(cityParam)}&page=${page}`, { headers: authHeaders })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return (await r.json()) as ChurnResponse;
      })
      .then((json) => {
        if (alive) setResp(json);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [threshold, cityParam, page, authHeaders]);

  async function downloadCsv() {
    const url = `/api/growth/churn?days=${threshold}&city=${encodeURIComponent(cityParam)}&format=csv`;
    const res = await fetch(url, { headers: authHeaders });
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = `potential-churn-${threshold}d.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objUrl);
  }

  const rows = resp?.rows ?? [];
  const total = resp?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE + rows.length);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Potential churn players</div>
          <div className={styles.cardSub}>Players who previously held a spot but have not returned.</div>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={downloadCsv}>
          Download CSV
        </button>
      </div>

      <div className={styles.controlsRow} style={{ marginBottom: 14 }}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="churnCity">
            City
          </label>
          <select
            id="churnCity"
            className={styles.control}
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setPage(0);
            }}
          >
            {cityOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.churnGrid}>
        {BUCKETS.map((b, i) => (
          <button
            key={b}
            type="button"
            className={`${styles.churnCell} ${threshold === b ? styles.churnCellActive : ""} ${
              i === 2 ? styles.churnCellWarn : i === 3 ? styles.churnCellCrit : ""
            }`}
            aria-pressed={threshold === b}
            onClick={() => {
              setThreshold(b);
              setPage(0);
            }}
          >
            <div className={styles.churnCellLabel}>Inactive ≥ {b} days</div>
            <div className={styles.churnCellValue}>{resp ? fmtInt(resp.counts[String(b)]) : "—"}</div>
          </button>
        ))}
      </div>

      <div className={styles.summaryLine}>
        {error ? (
          <span className={styles.errorMsg}>Could not load churn list: {error}</span>
        ) : loading ? (
          "Loading…"
        ) : (
          <>
            {countLabel(total, "player")} inactive ≥ {threshold} days
            {total > 0 ? ` — showing ${fmtInt(from)}–${fmtInt(to)} (page ${page + 1} of ${pageCount})` : ""}. CSV has all.
          </>
        )}
      </div>

      <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
        <table className={styles.recordTable}>
          <thead>
            <tr>
              <th>Player ID</th>
              <th>City</th>
              <th>Field</th>
              <th className="num">Days inactive</th>
              <th className="num">Matches played</th>
              <th>Last played</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.u}>
                <td>{p.u}</td>
                <td>{p.city}</td>
                <td>{p.field}</td>
                <td className="num">{fmtInt(p.days)}</td>
                <td className="num">{fmtInt(p.matches)}</td>
                <td>{p.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.controlsRow} style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={loading || page === 0}
        >
          Prev
        </button>
        <span className={styles.pill}>
          Page {page + 1} of {pageCount}
        </span>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={loading || page >= pageCount - 1}
        >
          Next
        </button>
      </div>

      <div className={styles.footnote}>
        This is the count of <b>distinct played players</b> inactive ≥ {threshold} days (one row per played player in
        growth_player_profile), not participation rows. Play data starts January 2026, so &ldquo;inactive 120
        days&rdquo; means no play since about April, and a player whose only match was in January necessarily reads as
        churned. Read the 90- and 120-day buckets with that in mind.
      </div>
    </div>
  );
}
