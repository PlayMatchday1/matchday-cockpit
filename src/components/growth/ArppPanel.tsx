"use client";

import { useState, type ReactNode } from "react";
import type { ArppCard, ArppEntity, ArppTriple, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";

// Average revenue per player. Two tables and nothing else: a one-row summary
// (Matchday) and a per-entity breakdown. Two independent toggles — mode
// {monthly, annual} and view {city, field}. All revenue math is precomputed on
// data.arppCard; this component only formats and renders. A null cur/prev/py
// means the entity did not exist in that period → em-dash, never $0.00.

type Mode = "monthly" | "annual";
type View = "city" | "field";

// "$12.34" for a number, null for a missing period (renders as em-dash).
const moneyStr = (v: number | null): string => (v == null ? "—" : "$" + v.toFixed(2));
// dollars comma-grouped with 2 decimals, e.g. 2708.25 → "2,708.25"
const grp = (v: number): string => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MoneyCell({ v }: { v: number | null }) {
  return v == null ? <td className={styles.nd}>—</td> : <td>{"$" + v.toFixed(2)}</td>;
}

function PctCell({ a, b }: { a: number | null; b: number | null }) {
  const d = a == null || b == null || b === 0 ? null : ((a - b) / b) * 100;
  if (d == null) return <td className={styles.nd}>—</td>;
  return (
    <td>
      <span className={`${styles.status} ${d >= 0 ? styles.statusGreen : styles.statusRed}`}>
        {`${d >= 0 ? "+" : ""}${d.toFixed(1)}%`}
      </span>
    </td>
  );
}

export default function ArppPanel({ data, scopeChip }: { data: GrowthData; scopeChip?: ReactNode }) {
  const [mode, setMode] = useState<Mode>("monthly");
  const [view, setView] = useState<View>("city");

  const card: ArppCard | undefined = data.arppCard;
  if (!card) return null;

  const annual = mode === "annual";
  const md: ArppTriple = annual ? card.annual.matchday : card.monthly.matchday;
  const rows: ArppEntity[] = (annual ? card.annual : card.monthly)[view === "city" ? "cities" : "fields"];

  const sub = annual
    ? "Each year's player revenue compared with the two years before it"
    : "Selected month compared with the previous month and the same month one year earlier";

  const c1 = annual ? `${card.curYear} YTD` : "Current month";
  const c2 = annual ? `${card.prevYear}` : "Previous month";
  const c3 = annual ? `${card.pyYear}` : "Previous year";
  const d1 = annual ? "YoY" : "MoM";
  const d2 = annual ? "2-yr" : "YoY";
  const entityHeader = view === "city" ? "City" : "Field";
  const ent = view === "city" ? "city" : "field";

  const sorted = [...rows].sort((a, b) => (b.cur ?? -Infinity) - (a.cur ?? -Infinity));

  // Footnote 1: compute the direction rather than assuming it. On City View the
  // network line sits above the top city; a single field can beat it.
  const curValues = rows.map((r) => r.cur).filter((v): v is number => v != null);
  const top = curValues.length ? Math.max(...curValues) : null;
  const above = md.cur != null && top != null && md.cur > top;

  const seg = (
    active: boolean,
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      className={`${styles.segBtn} ${active ? styles.segBtnActive : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Average revenue per player</div>
          <div className={styles.cardSub} id="arppSub">
            {sub}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>View</span>
            <div className={styles.segmented} id="arppMode">
              {seg(mode === "monthly", "Monthly", () => setMode("monthly"))}
              {seg(mode === "annual", "Annual sum", () => setMode("annual"))}
            </div>
          </div>
        </div>
      </div>

      {/* summary table — one Matchday row */}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead id="arppSummaryHead">
            <tr>
              <th>Matchday</th>
              <th>{c1}</th>
              <th>{c2}</th>
              <th>{c3}</th>
              <th>{d1}</th>
              <th>{d2}</th>
            </tr>
          </thead>
          <tbody id="arppSummaryBody">
            <tr className={styles.summaryRow}>
              <td className={styles.nameCell}>Matchday</td>
              <MoneyCell v={md.cur} />
              <MoneyCell v={md.prev} />
              <MoneyCell v={md.py} />
              <PctCell a={md.cur} b={md.prev} />
              <PctCell a={md.cur} b={md.py} />
            </tr>
          </tbody>
        </table>
      </div>

      {/* breakdown control + entity count */}
      <div className={styles.arppToolbar}>
        <span className={styles.fieldLabel}>Breakdown</span>
        <div className={styles.segmented} id="arppView">
          {seg(view === "city", "City View", () => setView("city"))}
          {seg(view === "field", "Field View", () => setView("field"))}
        </div>
        <span className={styles.entityCount} id="arppCount">
          {`${rows.length} ${view === "city" ? "cities" : "fields"}`}
        </span>
      </div>

      {/* detail table — one row per entity */}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead id="arppDetailHead">
            <tr>
              <th>{entityHeader}</th>
              <th>{c1}</th>
              <th>{c2}</th>
              <th>{c3}</th>
              <th>{d1}</th>
              <th>{d2}</th>
            </tr>
          </thead>
          <tbody id="arppDetailBody">
            {sorted.map((r, i) => (
              <tr key={`${r.name}-${r.city ?? ""}`}>
                <td className={styles.nameCell}>
                  <span className={styles.rank}>{i + 1}</span>
                  {r.name}
                  {view === "field" && r.city ? <span className={styles.nd}> · {r.city}</span> : null}
                </td>
                <MoneyCell v={r.cur} />
                <MoneyCell v={r.prev} />
                <MoneyCell v={r.py} />
                <PctCell a={r.cur} b={r.prev} />
                <PctCell a={r.cur} b={r.py} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* footnote 1 — denominator note, direction computed from the data */}
      <div className={styles.footnote} id="arppFoot">
        <b>Matchday is not the average of the rows below it.</b>{" "}
        {above
          ? `${moneyStr(md.cur)} sits above every ${ent}, the top being ${moneyStr(top)}. `
          : `${moneyStr(md.cur)} sits below the top ${ent} at ${moneyStr(top)}. `}
        {`The network counts a player once (${card.denom.network.toLocaleString()} this month) while each ${ent} counts its own (${card.denom.citySum.toLocaleString()} added together), so the same revenue divides by a different number and the rows cannot be averaged back to the top line. `}
        <b>An em-dash</b> means the {ent} did not exist in that period — never $0.00, which would read as a real figure.
      </div>

      {/* footnote 2 — view-specific */}
      <div className={styles.footnote} id="arppFoot2">
        {view === "field" ? (
          <>
            <b>Membership at field level.</b> Each member&rsquo;s monthly fee is split across the matches they played that
            month and attributed to those fields. {card.membership.zeroMatchMembers} members paid but played no matches
            this month, so ${grp(card.membership.unallocated)} has no field to land on and is held at city level.
            Allocated ${grp(card.membership.allocated)} plus unallocated equals total membership revenue of $
            {grp(card.membership.total)}.
          </>
        ) : (
          <>
            <b>Deleted accounts are excluded from both sides.</b> A player who deleted their account contributes neither
            revenue nor a headcount — counting their spend without counting them overstates every figure on this card.
          </>
        )}
      </div>
    </div>
  );
}
