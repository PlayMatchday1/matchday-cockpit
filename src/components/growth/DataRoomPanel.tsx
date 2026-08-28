"use client";

// PLAYER DATA ROOM — a pivot builder over the server-side fact table
// (POST /api/lifecycle/dataroom). Every figure comes from the endpoint; clicking a value cell
// opens a DRAWER listing the distinct players behind it. CSVs are built server-side.
//
// ── WHAT THE REBUILD CHANGED, AND WHY (2026-08-27) ───────────────────────────────────────────
//
// 1. ONE BUILDER STRIP. It was three stacked wells about 350px tall, so the first number was below
//    the fold on every screen. Zones are rows of chips now; fields DRAG between Rows and Columns
//    and a ⇄ Swap does the most common move in one click instead of four.
//
// 2. THE TOTAL COLUMN NAMES ITS OWN WINDOW. It read "Total" while summing Apr 2023 – Sep 2026
//    beside columns showing Feb – Sep 2026 — Austin's visible cells added to 6,712 and the total
//    said 7,450. The header prints the window the figure covers, from the same filters.
//    AND IT SAYS WHICH KIND OF TOTAL IT IS: for Spots/Revenue/Matches it is the sum of the visible
//    cells; for Players/New players it is a DISTINCT COUNT and is deliberately smaller than that
//    sum, because a player active in five months is one player and five cells.
//
// 3. HEAT SHADING across the whole grid — one hue, light to dark, capped well short of the ink
//    (darkest step measures 8.98:1 against the text; AA wants 4.5).
//
// 4. STICKY header row and first column.
//
// 5. THE DRILL-DOWN IS THE DRAWER. It used to be a sentence under the table explaining that cells
//    were clickable. The drawer opening IS the explanation; the clicked cell stays outlined while
//    it is open.
//
// 6. NOTHING BELOW THE TOTALS ROW. No legend, no note, no explanation.

import RevenueBasisNote from "@/components/RevenueBasisNote";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agg, Dim, DrilledPlayer, Metric, PivotConfig, PivotTable, ValueSpec } from "@/lib/dataRoom";
import { heatRange, heatStep, heatColour, isAdditive, tableTitle, swapAxes, canSwap, HEAT_STEPS } from "@/lib/dataRoom";
import { monthLabel } from "./format";

const DIMS: Dim[] = ["City", "Field", "Month", "Year", "Cohort year", "Cohort month"];
const METRICS: Record<Metric, Agg[]> = {
  Players: ["Count"], "New players": ["Count"],
  "Spots booked": ["Sum", "Average"], Revenue: ["Sum", "Average"], Matches: ["Sum", "Average"],
};
const METRIC_LIST = Object.keys(METRICS) as Metric[];

type Filters = { from: string; to: string; city: string; field: string };
type TotalCol = { window: string; kind: "sum" | "distinct" };
type PivotResponse = PivotTable & {
  totalCol?: TotalCol; cached?: boolean;
  meta: { monthsAvailable: string[]; cities: string[]; fieldsByCity: Record<string, string[]> };
};
// The drawer's rows carry a name and a phone that the pivot never does — see the route.
type DrilledPerson = DrilledPlayer & { name: string | null; phone: string | null };
type CellResponse = { players: DrilledPerson[]; count: number };
type OpenCell = { r: string; c: string; v: number | null };

type Preset = { name: string; rows: Dim[]; cols: Dim[]; vals: ValueSpec[] };
// KEPT VERBATIM — the "start from" presets, including the one that stacks two fields in Rows.
const PRESETS: Preset[] = [
  { name: "Players by city by month", rows: ["City"], cols: ["Month"], vals: [{ metric: "Players", agg: "Count" }] },
  { name: "Spots per player by field", rows: ["Field"], cols: [], vals: [{ metric: "Spots booked", agg: "Sum" }, { metric: "Players", agg: "Count" }] },
  { name: "Revenue by cohort year", rows: ["Cohort year"], cols: [], vals: [{ metric: "Revenue", agg: "Sum" }, { metric: "Players", agg: "Count" }] },
  { name: "New players by city", rows: ["City"], cols: ["Month"], vals: [{ metric: "New players", agg: "Count" }] },
  // STACKED ROWS ARE USED — this preset is the caller, which is why the feature stays. It lives in
  // the chip strip like any other field rather than behind a + that appends to a hidden list.
  { name: "Field by month", rows: ["City", "Field"], cols: ["Month"], vals: [{ metric: "Spots booked", agg: "Sum" }] },
];

const num = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const showVal = (v: number | null, metric: Metric) => (v == null ? "—" : metric === "Revenue" ? money(v) : num(v));

export default function DataRoomPanel({ authHeaders, scopeChip }: { authHeaders: Record<string, string>; scopeChip?: ReactNode }) {
  const [rows, setRows] = useState<Dim[]>([...PRESETS[0].rows]);
  const [cols, setCols] = useState<Dim[]>([...PRESETS[0].cols]);
  const [vals, setVals] = useState<ValueSpec[]>(PRESETS[0].vals.map((v) => ({ ...v })));
  const [filters, setFilters] = useState<Filters>({ from: "", to: "", city: "all", field: "all" });
  const [preset, setPreset] = useState<number | null>(0);
  const [pivot, setPivot] = useState<PivotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  const [cellData, setCellData] = useState<CellResponse | null>(null);
  const [drag, setDrag] = useState<{ zone: "rows" | "cols"; i: number } | null>(null);
  const [over, setOver] = useState<"rows" | "cols" | null>(null);
  const [copied, setCopied] = useState(false);
  const [addOpen, setAddOpen] = useState<"rows" | "cols" | "vals" | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const requestConfig = useMemo<PivotConfig>(() => ({
    rows, cols, vals,
    filters: { from: filters.from || "1900-01", to: filters.to || "2999-12", city: filters.city, field: filters.field },
  }), [rows, cols, vals, filters]);

  const postJson = useCallback(async <T,>(body: unknown): Promise<T> => {
    const res = await fetch("/api/lifecycle/dataroom", {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }, [authHeaders]);

  async function downloadBlob(body: unknown, filename: string) {
    const res = await fetch("/api/lifecycle/dataroom", {
      method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(body),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    /* WAIT FOR THE TOKEN. The frame used to hold this panel behind g.data, which incidentally meant
     * authHeaders had long since arrived by the time it mounted. It mounts immediately now — which
     * is the point — so it has to skip the fetch until the provider has a session, or the first
     * request goes out unauthenticated and comes back 401. Harmless, retried a moment later, and
     * still a wasted round trip and an error in the log for nothing. */
    if (!Object.keys(authHeaders).length) return;
    let alive = true;
    setLoading(true);
    postJson<PivotResponse>({ mode: "pivot", config: requestConfig })
      .then((resp) => {
        if (!alive) return;
        setPivot(resp); setLoading(false);
        if (filters.from === "" && resp.meta?.monthsAvailable?.length) {
          const m = resp.meta.monthsAvailable;
          setFilters((f) => ({ ...f, from: m[0], to: m[m.length - 1] }));
        }
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestConfig, postJson, authHeaders]);

  useEffect(() => {
    if (!openCell) { setCellData(null); return; }
    let alive = true;
    setCellData(null);
    postJson<CellResponse>({ mode: "cell", config: requestConfig, r: openCell.r, c: openCell.c })
      .then((resp) => { if (alive) setCellData(resp); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCell]);

  const edited = () => { setPreset(null); setOpenCell(null); };
  const applyPreset = (i: number) => {
    const p = PRESETS[i];
    setRows([...p.rows]); setCols([...p.cols]); setVals(p.vals.map((v) => ({ ...v })));
    setPreset(i); setOpenCell(null);
  };

  /* SWAP. Pure — the same fields, the opposite zones — and it REFUSES rather than dropping a field
   * when Rows is two deep, because Columns holds one. A swap that silently discarded the operator's
   * second field would be worse than a disabled button. */
  const swappable = canSwap({ rows, cols, vals, filters: requestConfig.filters });
  const doSwap = () => {
    const next = swapAxes({ rows, cols, vals, filters: requestConfig.filters });
    if (!next) return;
    setRows(next.rows); setCols(next.cols); edited();
  };

  // ── drag between zones ───────────────────────────────────────────────────────────────────────
  const dropOn = (zone: "rows" | "cols") => {
    if (!drag) return;
    const from = drag.zone === "rows" ? rows : cols;
    const dim = from[drag.i];
    setOver(null); setDrag(null);
    if (!dim || drag.zone === zone) return;
    if (zone === "cols" && cols.length >= 1) return;      // Columns holds one
    if (zone === "rows" && rows.length >= 2) return;      // Rows holds at most two, as the preset does
    if (drag.zone === "rows") { setRows(rows.filter((_, j) => j !== drag.i)); setCols([dim]); }
    else { setCols([]); setRows([...rows, dim]); }
    edited();
  };

  const free = DIMS.filter((d) => !rows.includes(d) && !cols.includes(d));
  const addDim = (zone: "rows" | "cols", d: Dim) => {
    if (zone === "rows") setRows([...rows, d]); else setCols([d]);
    setAddOpen(null); edited();
  };
  const removeDim = (zone: "rows" | "cols", i: number) => {
    if (zone === "rows") { if (rows.length > 1) setRows(rows.filter((_, j) => j !== i)); }
    else setCols([]);
    edited();
  };
  const addVal = (m: Metric) => { setVals([...vals, { metric: m, agg: METRICS[m][0] }]); setAddOpen(null); edited(); };
  const changeAgg = (i: number, a: Agg) => { setVals(vals.map((v, j) => (j === i ? { ...v, agg: a } : v))); edited(); };
  const removeVal = (i: number) => { if (vals.length > 1) { setVals(vals.filter((_, j) => j !== i)); edited(); } };

  const months = pivot?.meta?.monthsAvailable ?? [];
  const cities = pivot?.meta?.cities ?? [];
  const fieldOptions = filters.city === "all"
    ? [...new Set(Object.values(pivot?.meta?.fieldsByCity ?? {}).flat())].sort()
    : (pivot?.meta?.fieldsByCity ?? {})[filters.city] ?? [];
  const setF = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setOpenCell(null); };

  const v0 = vals[0];
  const heat = useMemo(() => (pivot ? heatRange(pivot, 0) : { min: 0, max: 0 }), [pivot]);
  const title = tableTitle({ rows, cols, vals, filters: requestConfig.filters });
  const totalCol = pivot?.totalCol;

  /* COPY PHONES — the ones that exist. A player with no phone on file is skipped rather than
   * pasted as an empty line, and the button says how many it actually copied, because a list that
   * silently drops rows is a list somebody will message and wonder about. */
  const withPhone = cellData?.players.filter((p) => p.phone) ?? [];
  const copyPhones = async () => {
    if (!withPhone.length) return;
    await navigator.clipboard.writeText(withPhone.map((p) => p.phone).join("\n"));
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="drRoot" data-testid="dataroom">
      {/* ── ONE BUILDER STRIP ─────────────────────────────────────────────────────────────────── */}
      <RevenueBasisNote basis="pre-tax" />
      <div className="drBuild" data-testid="dr-builder">
        <div className="drRow">
          <span className="drZl">Rows</span>
          <div className={`drZone${over === "rows" ? " drOver" : ""}`} data-testid="dr-zone-rows"
            onDragOver={(e) => { e.preventDefault(); setOver("rows"); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); dropOn("rows"); }}>
            {rows.map((d, i) => (
              <span key={d} className="drFld" draggable data-testid="dr-chip-row"
                onDragStart={() => setDrag({ zone: "rows", i })} onDragEnd={() => { setDrag(null); setOver(null); }}>
                {d}
                <button type="button" aria-label={`Remove ${d} from rows`} disabled={rows.length <= 1} onClick={() => removeDim("rows", i)}>×</button>
              </span>
            ))}
            {free.length > 0 && rows.length < 2 && (
              <button type="button" className="drAdd" data-testid="dr-add-row" onClick={() => setAddOpen(addOpen === "rows" ? null : "rows")}>+</button>
            )}
            {addOpen === "rows" && (
              <span className="drPick">{free.map((d) => <button key={d} type="button" onClick={() => addDim("rows", d)}>{d}</button>)}</span>
            )}
          </div>

          <span className="drZl">Columns</span>
          <div className={`drZone${over === "cols" ? " drOver" : ""}`} data-testid="dr-zone-cols"
            onDragOver={(e) => { e.preventDefault(); setOver("cols"); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); dropOn("cols"); }}>
            {cols.map((d, i) => (
              <span key={d} className="drFld" draggable data-testid="dr-chip-col"
                onDragStart={() => setDrag({ zone: "cols", i })} onDragEnd={() => { setDrag(null); setOver(null); }}>
                {d}
                <button type="button" aria-label={`Remove ${d} from columns`} onClick={() => removeDim("cols", i)}>×</button>
              </span>
            ))}
            {!cols.length && free.length > 0 && (
              <button type="button" className="drAdd" data-testid="dr-add-col" onClick={() => setAddOpen(addOpen === "cols" ? null : "cols")}>+</button>
            )}
            {addOpen === "cols" && (
              <span className="drPick">{free.map((d) => <button key={d} type="button" onClick={() => addDim("cols", d)}>{d}</button>)}</span>
            )}
          </div>

          {/* THE MOST COMMON MOVE IN ANY PIVOT TABLE, IN ONE CLICK. It took four. */}
          <button type="button" className="drSwap" data-testid="dr-swap" onClick={doSwap} disabled={!swappable}
            title={swappable ? "Exchange rows and columns" : "Rows holds two fields and Columns holds one — a swap would drop one, so it refuses"}>
            ⇄ Swap
          </button>
        </div>

        <div className="drRow">
          <span className="drZl">Values</span>
          <div className="drZone">
            {vals.map((v, i) => (
              <span key={`${v.metric}-${i}`} className="drFld drV" data-testid="dr-chip-val">
                {/* ONE WORD, NOT A SENTENCE. Revenue here is the PRE-TAX price
                    (mdapi_match_players.amount). It used to be the card charge, which carries
                    5-9% city sales tax we collect and remit — money that was never ours and is
                    booked nowhere as a liability. A 5-9% definition is invisible without the
                    word, and the whole point of migration 0154 is that nobody re-derives it. */}
                {v.metric === "Revenue" ? <>Revenue <em className="drTax">pre-tax</em></> : v.metric}
                <select value={v.agg} aria-label={`${v.metric} aggregate`} onChange={(e) => changeAgg(i, e.target.value as Agg)}>
                  {METRICS[v.metric].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <button type="button" aria-label={`Remove ${v.metric}`} disabled={vals.length <= 1} onClick={() => removeVal(i)}>×</button>
              </span>
            ))}
            <button type="button" className="drAdd" data-testid="dr-add-val" onClick={() => setAddOpen(addOpen === "vals" ? null : "vals")}>+</button>
            {addOpen === "vals" && (
              <span className="drPick">{METRIC_LIST.map((m) => <button key={m} type="button" onClick={() => addVal(m)}>{m}</button>)}</span>
            )}
          </div>
          <span className="drDiv" />
          <span className="drZl">Window</span>
          <select className="drSel" aria-label="From" value={filters.from} disabled={!months.length} onChange={(e) => setF({ from: e.target.value })}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <span className="drDash">→</span>
          <select className="drSel" aria-label="To" value={filters.to} disabled={!months.length} onChange={(e) => setF({ to: e.target.value })}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <select className="drSel" aria-label="City" value={filters.city} onChange={(e) => setF({ city: e.target.value, field: "all" })}>
            <option value="all">All cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="drSel" aria-label="Field" value={filters.field} onChange={(e) => setF({ field: e.target.value })}>
            <option value="all">All fields</option>
            {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <span className="drSpacer" />
          {scopeChip}
        </div>

        {/* THE PRESETS SHARE THE TABLE'S OWN HEADER ROW rather than taking a third builder row —
            the whole point of the strip is that the first number is above the fold. */}
      </div>

      {/* ── THE TABLE ─────────────────────────────────────────────────────────────────────────── */}
      <div className="drThead">
        {PRESETS.map((p, i) => (
          <button key={p.name} type="button" className={`drPre${preset === i ? " on" : ""}`} onClick={() => applyPreset(i)}>{p.name}</button>
        ))}
        <span className="drDiv" />
        <b data-testid="dr-title">{title}</b>
        <span className="drTsub" data-testid="dr-sub">
          {/* "building…" ONLY WHEN THERE IS NOTHING TO READ. It was showing beside a full table
              during every re-fetch, which reads as "these numbers are not final" when they are. */}
          {pivot ? `${num(pivot.rowKeys.length)} rows · ${num(pivot.distinctPlayers)} distinct players${loading ? " · updating" : ""}` : loading ? "building…" : ""}
        </span>
        <span className="drSpacer" />
        <button type="button" className="drBtn" data-testid="dr-export" disabled={!pivot}
          onClick={() => downloadBlob({ mode: "tableCsv", config: requestConfig }, "data-room.csv")}>Export</button>
      </div>

      <div className="drGrid" ref={gridRef} data-testid="dr-grid">
        {pivot && v0 && (
          <table className="drPv">
            <thead>
              <tr>
                <th>{rows.join(" · ")}</th>
                {pivot.hasCols && pivot.colKeys.map((c) => <th key={c}>{c}</th>)}
                {!pivot.hasCols && <th>{v0.agg === "Count" ? v0.metric : `${v0.agg} of ${v0.metric}`}</th>}
                {pivot.hasCols && (
                  /* THE TOTAL COLUMN NAMES ITS WINDOW, and says whether it is a sum or a distinct
                     count. It read a bare "Total" over a different window than the columns. */
                  <th className="drRt" data-testid="dr-total-head">
                    {totalCol?.window ?? ""}
                    <em>{totalCol?.kind === "distinct" ? "distinct" : "total"}</em>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {pivot.rowKeys.map((r) => (
                <tr key={r}>
                  <th>{r}</th>
                  {pivot.colKeys.map((c) => {
                    const v = pivot.cells[r]?.[c]?.[0] ?? null;
                    const step = heatStep(v, heat.min, heat.max);
                    const sel = openCell?.r === r && openCell?.c === c;
                    return (
                      <td key={c} className={`${v == null ? "drN" : ""}${sel ? " drSel" : ""}`}
                        style={v == null ? undefined : { background: heatColour(step) }}
                        data-testid="dr-cell" data-heat={v == null ? "" : step} data-row={r} data-col={c}>
                        {v == null ? "—" : (
                          <button type="button" onClick={() => setOpenCell({ r, c: pivot.hasCols ? c : "__all__", v })}>
                            {showVal(v, v0.metric)}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  {pivot.hasCols && (
                    <td className="drRt" data-testid="dr-row-total" data-row={r}>{showVal(pivot.rowTotals[r]?.[0] ?? null, v0.metric)}</td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>All {rows.join(" · ").toLowerCase()}</th>
                {pivot.colKeys.map((c, ci) => (
                  <td key={c} data-testid="dr-col-total">{showVal(pivot.colTotals[ci]?.[0] ?? null, v0.metric)}</td>
                ))}
                {pivot.hasCols && <td className="drRt" data-testid="dr-grand">{showVal(pivot.grandTotal?.[0] ?? null, v0.metric)}</td>}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      {/* NOTHING BELOW THE TOTALS ROW. No legend, no note, no explanation of the drill-down — the
          drawer opening is the explanation. */}

      {/* ── THE DRAWER ────────────────────────────────────────────────────────────────────────── */}
      {openCell && (
        <aside className="drDrawer" data-testid="dr-drawer">
          <div className="drDh">
            <div>
              <div className="drDt" data-testid="dr-drawer-title">{openCell.r}{openCell.c && openCell.c !== "__all__" ? ` · ${openCell.c}` : ""}</div>
              <div className="drDs" data-testid="dr-drawer-sub">
                {v0.agg === "Count" ? v0.metric : `${v0.agg} of ${v0.metric}`} {showVal(openCell.v, v0.metric)}
                {cellData ? ` · ${num(cellData.count)} player${cellData.count === 1 ? "" : "s"}` : " · loading…"}
              </div>
            </div>
            <button type="button" className="drDx" data-testid="dr-drawer-close" aria-label="Close" onClick={() => setOpenCell(null)}>×</button>
          </div>
          <div className="drDbody">
            {!cellData && <p className="drDempty">Reading the players behind this cell…</p>}
            {cellData && cellData.players.length === 0 && <p className="drDempty">No players in this cell.</p>}
            {cellData && cellData.players.map((p) => (
              <div className="drDrow" key={p.id} data-testid="dr-drawer-player">
                <span className="drDn">
                  <b>{p.name ?? `ID ${p.id}`}</b>
                  <span>{p.phone ?? "no phone on file"} · {p.city}</span>
                </span>
                <span className="drDm">{p.months} mo</span>
                <span className="drDm">{num(p.spots)} spots</span>
                <span className="drDm">{money(p.revenue)}</span>
              </div>
            ))}
          </div>
          <div className="drDf">
            <button type="button" className="drBtn" data-testid="dr-drawer-copy" disabled={!withPhone.length} onClick={copyPhones}
              title={cellData && withPhone.length < cellData.players.length ? `${cellData.players.length - withPhone.length} of these players have no phone on file` : undefined}>
              {copied ? `Copied ${withPhone.length}` : `Copy phones${cellData ? ` (${withPhone.length})` : ""}`}
            </button>
            <button type="button" className="drBtn drP" data-testid="dr-drawer-export" disabled={!cellData?.players.length}
              onClick={() => downloadBlob({ mode: "cellCsv", config: requestConfig, r: openCell.r, c: openCell.c }, "players.csv")}>Export</button>
          </div>
        </aside>
      )}

      <style jsx>{`
        .drRoot { position: relative }
        .drBuild { border-bottom: 1px solid #E4EAE5 }
        .drRow { display: flex; align-items: center; gap: 7px; padding: 6px 14px; flex-wrap: wrap; row-gap: 5px }
        .drRow + .drRow { border-top: 1px solid #EFF3EF }
        .drZl { font-size: 10px; font-weight: 800; letter-spacing: .1em; color: #93A49A; text-transform: uppercase }
        .drZone { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 3px; border-radius: 9px; min-height: 32px }
        .drOver { outline: 2px dashed #BDEBD1; background: #E4FBEC }
        .drFld { display: inline-flex; align-items: center; gap: 6px; background: #E4FBEC; border: 1px solid #BDEBD1; color: #0B3D24;
          border-radius: 8px; padding: 4px 7px 4px 10px; font-weight: 700; font-size: 12.5px; cursor: grab; user-select: none; white-space: nowrap }
        .drFld.drV { background: #EFF6FF; border-color: #BBD6F6; color: #12406F; cursor: default }
        .drFld button { border: 0; background: none; font: inherit; color: inherit; opacity: .5; cursor: pointer; padding: 0 1px; line-height: 1 }
        .drFld button:hover:not(:disabled) { opacity: 1 }
        .drFld button:disabled { opacity: .2; cursor: not-allowed }
        .drFld select { appearance: none; border: 0; background: rgba(255,255,255,.75); border-radius: 5px; font: inherit; font-size: 11.5px; font-weight: 700; color: inherit; padding: 2px 5px; cursor: pointer }
        .drAdd { border: 1px dashed #CFDCD4; background: #fff; border-radius: 8px; padding: 3px 10px; font: inherit; font-size: 13px; font-weight: 800; color: #6E8076; cursor: pointer; min-height: 26px }
        .drAdd:hover { border-color: #0B7A3E; color: #0B7A3E }
        .drPick { display: inline-flex; gap: 4px; flex-wrap: wrap }
        .drPick button { border: 1px solid #E4EAE5; background: #fff; border-radius: 7px; padding: 4px 9px; font: inherit; font-size: 12px; font-weight: 600; color: #3C4F44; cursor: pointer }
        .drPick button:hover { border-color: #0B7A3E; color: #0B7A3E }
        .drSwap { border: 1px solid #E4EAE5; background: #fff; border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 12.5px; font-weight: 700; color: #3C4F44; cursor: pointer; min-height: 30px }
        .drSwap:disabled { opacity: .4; cursor: not-allowed }
        .drSel { border: 1px solid #E4EAE5; border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12.5px; font-weight: 600; color: #3C4F44; background: #fff; min-height: 30px }
        .drDash { color: #93A49A; font-size: 12px }
        .drSpacer { flex: 1 }
        .drDiv { width: 1px; align-self: stretch; background: #EFF3EF; margin: 0 3px }
        .drTax { font-style: normal; font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
          text-transform: uppercase; color: #6E8076; margin-left: 5px }
        .drPre { border: 1px solid #E4EAE5; background: #fff; border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 12px; font-weight: 600; color: #3C4F44; cursor: pointer; white-space: nowrap }
        .drPre.on { background: #0F3323; border-color: #0F3323; color: #fff }
        .drThead { display: flex; align-items: center; gap: 8px; padding: 8px 14px; flex-wrap: wrap; row-gap: 6px }
        .drThead b { font-size: 15px; letter-spacing: -.2px }
        .drTsub { color: #6E8076; font-size: 12.5px }
        .drBtn { border: 1px solid #E4EAE5; background: #fff; border-radius: 8px; padding: 6px 13px; font: inherit; font-weight: 700; font-size: 12.5px; color: #3C4F44; cursor: pointer }
        .drBtn.drP { background: #4FE07E; border-color: #4FE07E; color: #08281A }
        .drBtn:disabled { opacity: .4; cursor: not-allowed }
        .drGrid { overflow: auto; max-height: 62vh; border-top: 1px solid #E4EAE5 }
        .drPv { border-collapse: separate; border-spacing: 0; width: 100%; font-variant-numeric: tabular-nums }
        .drPv th, .drPv td { padding: 7px 11px; white-space: nowrap; border-bottom: 1px solid #EFF3EF }
        .drPv thead th { background: #F7FAF8; font-size: 10px; letter-spacing: .09em; color: #8C9E93; text-transform: uppercase;
          text-align: right; position: sticky; top: 0; z-index: 3; border-bottom: 1px solid #E4EAE5 }
        .drPv thead th:first-child { text-align: left; left: 0; z-index: 5 }
        .drPv thead th em { display: block; font-style: normal; font-size: 9px; opacity: .75; letter-spacing: .06em }
        .drPv tbody th { text-align: left; font-weight: 700; font-size: 13px; background: #fff; position: sticky; left: 0; z-index: 2 }
        .drPv td { text-align: right; font-size: 13px }
        .drPv td.drN { color: #C3CFC7 }
        .drPv td button { border: 0; background: none; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; color: #10231A; cursor: pointer; padding: 2px 5px; border-radius: 5px; width: 100%; text-align: right; font-weight: 600 }
        .drPv td button:hover { outline: 2px solid #2a78d6; outline-offset: -2px }
        .drPv td.drSel { outline: 2px solid #2a78d6; outline-offset: -2px }
        .drPv .drRt, .drPv thead th.drRt { background: #F7FAF8; font-weight: 700; position: sticky; right: 0; z-index: 2 }
        .drPv thead th.drRt { z-index: 4 }
        .drPv tfoot th, .drPv tfoot td { background: #0F3323; color: #fff; font-weight: 700; border-bottom: 0; position: sticky; bottom: 0; z-index: 3 }
        .drPv tfoot th { left: 0; z-index: 5; text-align: left }
        .drDrawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 94vw); background: #fff; border-left: 1px solid #E4EAE5;
          box-shadow: -14px 0 34px rgba(16,35,26,.13); z-index: 70; display: flex; flex-direction: column }
        .drDh { padding: 15px 17px; border-bottom: 1px solid #E4EAE5; display: flex; align-items: flex-start; gap: 12px }
        .drDt { font-weight: 700; font-size: 15px }
        .drDs { color: #6E8076; font-size: 12.5px; margin-top: 2px }
        .drDx { margin-left: auto; border: 1px solid #E4EAE5; background: #fff; border-radius: 8px; width: 30px; height: 30px; cursor: pointer; color: #6E8076; font-size: 15px; line-height: 1 }
        .drDbody { flex: 1; overflow: auto }
        .drDrow { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; align-items: center; padding: 8px 17px; border-bottom: 1px solid #EFF3EF; font-size: 12.5px }
        .drDn { display: flex; flex-direction: column; min-width: 0 }
        .drDn span { color: #6E8076; font-size: 11px; overflow-wrap: anywhere }
        .drDm { color: #3C4F44; font-variant-numeric: tabular-nums }
        .drDempty { padding: 16px 17px; color: #6E8076; font-size: 12.5px }
        .drDf { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 17px; border-top: 1px solid #E4EAE5 }
        @media (max-width: 760px) { .drDrawer { width: 100vw } }
      `}</style>
    </section>
  );
}
