"use client";

import { useEffect, useMemo, useState } from "react";
import type { Agg, Dim, DrilledPlayer, Metric, PivotConfig, PivotTable, ValueSpec } from "@/lib/dataRoom";
import { monthLabel } from "./format";

// Player Data Room — a live pivot builder over the server-side fact table
// (POST /api/growth/dataroom). Every figure comes from the endpoint; clicking a
// value cell drills to the distinct players behind it (mode:"cell"). CSVs are
// built server-side (mode:"tableCsv"/"cellCsv") — never in the browser. Two rules
// the backend holds and the copy explains: Players/New players are DISTINCT (rows
// don't sum to the grand total), and Average is always per player.

// ── palette (spec) — yellow/mint are fills only ─────────────────────────────
const FOREST = "#003326";
const INK = "#0d1f18";
const MUTED = "#5C6B62";
const LINE = "#dfe4da";
const SLOT = "#F7F9F6";
const MINT = "#2CDB87";
const MINT_SOFT = "#E4F9EF";
const YELLOW = "#FFFF3E";

// ── dims + metrics (exact strings; offer ONLY these aggs) ────────────────────
const DIMS: Dim[] = ["City", "Field", "Month", "Year", "Cohort year", "Cohort month"];
const METRICS: Record<Metric, Agg[]> = {
  Players: ["Count"],
  "New players": ["Count"],
  "Spots booked": ["Sum", "Average"],
  Revenue: ["Sum", "Average"],
  Matches: ["Sum", "Average"],
};
const METRIC_LIST = Object.keys(METRICS) as Metric[];

type Filters = { from: string; to: string; city: string; field: string };
type PivotResponse = PivotTable & {
  meta: { monthsAvailable: string[]; cities: string[]; fieldsByCity: Record<string, string[]> };
};
type CellResponse = { players: DrilledPlayer[]; count: number };
type OpenCell = { r: string; c: string; v: number };

type Preset = { name: string; rows: Dim[]; cols: Dim[]; vals: ValueSpec[] };
const PRESETS: Preset[] = [
  { name: "Players by city by month", rows: ["City"], cols: ["Month"], vals: [{ metric: "Players", agg: "Count" }] },
  { name: "Spots per player by field", rows: ["Field"], cols: [], vals: [{ metric: "Spots booked", agg: "Sum" }, { metric: "Players", agg: "Count" }] },
  { name: "Revenue by cohort year", rows: ["Cohort year"], cols: [], vals: [{ metric: "Revenue", agg: "Sum" }, { metric: "Players", agg: "Count" }] },
  { name: "New players by city", rows: ["City"], cols: ["Month"], vals: [{ metric: "New players", agg: "Count" }] },
  { name: "Field by month", rows: ["City", "Field"], cols: ["Month"], vals: [{ metric: "Spots booked", agg: "Sum" }] },
];

// ── formatting ───────────────────────────────────────────────────────────────
const num = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const showVal = (v: number | null, metric: Metric) => (v == null ? "—" : metric === "Revenue" ? money(v) : num(v));

export default function DataRoomPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
  // The whole config lives in state; the card OPENS on the first preset.
  const [rows, setRows] = useState<Dim[]>([...PRESETS[0].rows]);
  const [cols, setCols] = useState<Dim[]>([...PRESETS[0].cols]);
  const [vals, setVals] = useState<ValueSpec[]>(PRESETS[0].vals.map((v) => ({ ...v })));
  const [filters, setFilters] = useState<Filters>({ from: "", to: "", city: "all", field: "all" });
  const [preset, setPreset] = useState<number | null>(0);

  const [pivot, setPivot] = useState<PivotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  const [cellData, setCellData] = useState<CellResponse | null>(null);

  // add-row controls
  const [valAddMetric, setValAddMetric] = useState<Metric>("Players");
  const [valAddAgg, setValAddAgg] = useState<Agg>("Count");
  const [rowAddSel, setRowAddSel] = useState<Dim | "">("");
  const [colAddSel, setColAddSel] = useState<Dim | "">("");

  // Config sent to the server. Until meta arrives we don't know the month bounds,
  // so use a wide window that lets every fact through; the real bounds are set
  // once meta lands (below), which re-narrows to the true available range.
  const requestConfig = useMemo<PivotConfig>(
    () => ({
      rows,
      cols,
      vals,
      filters: { from: filters.from || "1900-01", to: filters.to || "2999-12", city: filters.city, field: filters.field },
    }),
    [rows, cols, vals, filters],
  );

  async function postJson<T>(body: unknown): Promise<T> {
    const res = await fetch("/api/growth/dataroom", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  async function downloadBlob(body: unknown, filename: string) {
    const res = await fetch("/api/growth/dataroom", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Pivot: refetch on any config change. A stale guard keeps out-of-order
  // responses from clobbering the current one.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    postJson<PivotResponse>({ mode: "pivot", config: requestConfig })
      .then((resp) => {
        if (!alive) return;
        setPivot(resp);
        setLoading(false);
        // First load: adopt the real month bounds.
        if (filters.from === "" && resp.meta?.monthsAvailable?.length) {
          const m = resp.meta.monthsAvailable;
          setFilters((f) => ({ ...f, from: m[0], to: m[m.length - 1] }));
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestConfig, authHeaders]);

  // Cell drill-down. openCell is cleared on every builder/filter mutation, so the
  // config here always matches the pivot the cell came from. Passing requestConfig
  // means the drawer respects the current filters (the backend scopes to them).
  useEffect(() => {
    if (!openCell) {
      setCellData(null);
      return;
    }
    let alive = true;
    postJson<CellResponse>({ mode: "cell", config: requestConfig, r: openCell.r, c: openCell.c }).then((resp) => {
      if (alive) setCellData(resp);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCell]);

  // ── mutations ──────────────────────────────────────────────────────────────
  // Any edit to a chip/agg/dim clears the preset highlight + closes the drawer.
  const editBuilder = () => {
    setPreset(null);
    setOpenCell(null);
  };
  const applyPreset = (i: number) => {
    const p = PRESETS[i];
    setRows([...p.rows]);
    setCols([...p.cols]);
    setVals(p.vals.map((v) => ({ ...v })));
    setPreset(i);
    setOpenCell(null);
  };

  const free = DIMS.filter((d) => !rows.includes(d) && !cols.includes(d));
  const rowAddValue: Dim | "" = free.includes(rowAddSel as Dim) ? rowAddSel : free[0] ?? "";
  const colAddValue: Dim | "" = free.includes(colAddSel as Dim) ? colAddSel : free[0] ?? "";

  const addRow = () => {
    if (rowAddValue) {
      setRows([...rows, rowAddValue]);
      editBuilder();
    }
  };
  const removeRow = (i: number) => {
    if (rows.length > 1) {
      setRows(rows.filter((_, j) => j !== i));
      editBuilder();
    }
  };
  const addCol = () => {
    if (cols.length < 1 && colAddValue) {
      setCols([colAddValue]);
      editBuilder();
    }
  };
  const removeCol = () => {
    setCols([]);
    editBuilder();
  };
  const addVal = () => {
    setVals([...vals, { metric: valAddMetric, agg: valAddAgg }]);
    editBuilder();
  };
  const removeVal = (i: number) => {
    if (vals.length > 1) {
      setVals(vals.filter((_, j) => j !== i));
      editBuilder();
    }
  };
  const changeAgg = (i: number, agg: Agg) => {
    setVals(vals.map((v, j) => (j === i ? { ...v, agg } : v)));
    editBuilder();
  };

  // Filters keep the preset highlight (they're not part of the builder shape),
  // but they close the drawer.
  const setCity = (city: string) => {
    setFilters((f) => ({ ...f, city, field: "all" }));
    setOpenCell(null);
  };
  const setField = (field: string) => {
    setFilters((f) => ({ ...f, field }));
    setOpenCell(null);
  };
  const setFrom = (from: string) => {
    setFilters((f) => ({ ...f, from, to: from > f.to ? from : f.to }));
    setOpenCell(null);
  };
  const setTo = (to: string) => {
    setFilters((f) => ({ ...f, to, from: to < f.from ? to : f.from }));
    setOpenCell(null);
  };

  const toggleCell = (r: string, c: string, v: number) =>
    setOpenCell((prev) => (prev && prev.r === r && prev.c === c && prev.v === v ? null : { r, c, v }));

  const changeAddMetric = (m: Metric) => {
    setValAddMetric(m);
    setValAddAgg(METRICS[m][0]);
  };

  // ── filter option data (from meta) ───────────────────────────────────────────
  const months = pivot?.meta.monthsAvailable ?? [];
  const cities = pivot?.meta.cities ?? [];
  const fieldsByCity = pivot?.meta.fieldsByCity ?? {};
  const fieldOptions =
    filters.city === "all"
      ? [...new Set(Object.values(fieldsByCity).flat())].sort()
      : fieldsByCity[filters.city] ?? [];

  const addAggOptions = METRICS[valAddMetric];
  const safeAddAgg = addAggOptions.includes(valAddAgg) ? valAddAgg : addAggOptions[0];

  // ── result header text ───────────────────────────────────────────────────────
  const valsLabel = vals.map((v) => `${v.agg} of ${v.metric}`).join(", ");
  const resultTitle = `${valsLabel} by ${rows.join(" and ")}${cols.length ? ` across ${cols.join(" and ")}` : ""}`;
  const resultMeta = pivot
    ? `${num(pivot.distinctPlayers)} players · ${filters.from ? monthLabel(filters.from) : "—"} – ${filters.to ? monthLabel(filters.to) : "—"}` +
      (filters.city !== "all" ? ` · ${filters.city}` : "") +
      (filters.field !== "all" ? ` · ${filters.field}` : "") +
      ` · ${pivot.rowKeys.length} ${pivot.rowKeys.length === 1 ? "row" : "rows"}`
    : "";

  const hasCols = pivot?.hasCols ?? false;
  const nv = vals.length;
  const rowsLabel = rows.join(" · ");
  const colsLabel = cols.join(" · ");

  // ── drawer derived values ────────────────────────────────────────────────────
  let drawerValue: number | null = null;
  let drawerLabel = "";
  let drawerSpec: ValueSpec | null = null;
  if (openCell && pivot) {
    drawerSpec = vals[openCell.v] ?? null;
    drawerValue =
      openCell.c === "__all__"
        ? pivot.rowTotals[openCell.r]?.[openCell.v] ?? null
        : pivot.cells[openCell.r]?.[openCell.c]?.[openCell.v] ?? null;
    drawerLabel =
      `${rowsLabel} ${openCell.r}` +
      (hasCols && openCell.c !== "__all__" ? ` · ${colsLabel} ${openCell.c}` : ", all columns");
  }
  const cellCount = cellData?.count ?? 0;
  const cellPlayers = cellData?.players ?? [];

  const downloadTable = () => downloadBlob({ mode: "tableCsv", config: requestConfig }, "data-room.csv");
  const downloadCell = () =>
    openCell &&
    downloadBlob({ mode: "cellCsv", config: requestConfig, r: openCell.r, c: openCell.c }, `players-${cellCount}.csv`);

  return (
    <div className="drRoot">
      <style>{DR_CSS}</style>
      <div className="drCard">
        {/* header */}
        <div className="drHeadRow">
          <div>
            <div className="drTitle">Player Data Room</div>
            <div className="drSub">
              Build the table you want, then click any number to see the players behind it and export them.
            </div>
          </div>
        </div>

        {/* presets */}
        <div className="drPresets">
          <span className="drPresetsL">Start from</span>
          {PRESETS.map((p, i) => (
            <button key={p.name} type="button" className={`drPre${preset === i ? " on" : ""}`} onClick={() => applyPreset(i)}>
              {p.name}
            </button>
          ))}
        </div>

        {/* wells */}
        <div className="drWells">
          <div className="drWell">
            <div className="drWellH">
              <b>Rows</b>
              <span>one or more dimensions</span>
            </div>
            <div className="drChips">
              {rows.map((d, i) => (
                <span className="drChip" key={`${d}-${i}`}>
                  {d}
                  <button type="button" aria-label={`Remove ${d}`} disabled={rows.length <= 1} onClick={() => removeRow(i)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="drAddrow">
              <select value={rowAddValue} onChange={(e) => setRowAddSel(e.target.value as Dim)} disabled={!free.length}>
                {free.length ? (
                  free.map((d) => <option key={d} value={d}>{d}</option>)
                ) : (
                  <option value="">all used</option>
                )}
              </select>
              <button type="button" className="drAdd" onClick={addRow} disabled={!free.length}>
                + Add
              </button>
            </div>
          </div>

          <div className="drWell">
            <div className="drWellH">
              <b>Columns</b>
              <span>optional · one max</span>
            </div>
            <div className="drChips">
              {cols.map((d) => (
                <span className="drChip" key={d}>
                  {d}
                  <button type="button" aria-label={`Remove ${d}`} onClick={removeCol}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="drAddrow">
              <select
                value={colAddValue}
                onChange={(e) => setColAddSel(e.target.value as Dim)}
                disabled={cols.length >= 1 || !free.length}
              >
                {free.length ? (
                  free.map((d) => <option key={d} value={d}>{d}</option>)
                ) : (
                  <option value="">all used</option>
                )}
              </select>
              <button type="button" className="drAdd" onClick={addCol} disabled={cols.length >= 1 || !free.length}>
                + Add
              </button>
            </div>
          </div>

          <div className="drWell">
            <div className="drWellH">
              <b>Values</b>
              <span>count, sum or average</span>
            </div>
            <div className="drChips">
              {vals.map((v, i) => (
                <span className="drChip" key={`${v.metric}-${i}`}>
                  {v.metric}
                  <select value={v.agg} onChange={(e) => changeAgg(i, e.target.value as Agg)} aria-label={`${v.metric} aggregate`}>
                    {METRICS[v.metric].map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                  <button type="button" aria-label={`Remove ${v.metric}`} disabled={vals.length <= 1} onClick={() => removeVal(i)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="drAddrow">
              <select value={valAddMetric} onChange={(e) => changeAddMetric(e.target.value as Metric)} aria-label="Add metric">
                {METRIC_LIST.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select value={safeAddAgg} onChange={(e) => setValAddAgg(e.target.value as Agg)} aria-label="Add aggregate">
                {addAggOptions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <button type="button" className="drAdd" onClick={addVal}>
                + Add
              </button>
            </div>
          </div>
        </div>

        {/* filters */}
        <div className="drFilters">
          <div className="drFld">
            <label htmlFor="drFrom">From</label>
            <select id="drFrom" value={filters.from} onChange={(e) => setFrom(e.target.value)} disabled={!months.length}>
              {months.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </div>
          <div className="drFld">
            <label htmlFor="drTo">To</label>
            <select id="drTo" value={filters.to} onChange={(e) => setTo(e.target.value)} disabled={!months.length}>
              {months.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </div>
          <div className="drFld">
            <label htmlFor="drCity">City</label>
            <select id="drCity" value={filters.city} onChange={(e) => setCity(e.target.value)}>
              <option value="all">All cities</option>
              {cities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="drFld">
            <label htmlFor="drField">Field</label>
            <select id="drField" value={filters.field} onChange={(e) => setField(e.target.value)}>
              <option value="all">All fields</option>
              {fieldOptions.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>

        {/* result header */}
        <div className="drRhead">
          <div>
            <strong>{resultTitle}</strong>
            <div className="drRmeta">{resultMeta || (loading ? "Loading…" : "")}</div>
          </div>
          <button type="button" className="drCsv" onClick={downloadTable} disabled={!pivot}>
            Download table
          </button>
        </div>

        {/* pivot table */}
        <div className="drTwrap">
          {pivot ? (
            <table className="drTable">
              <thead>
                {hasCols ? (
                  <>
                    <tr>
                      <th className="drDim" rowSpan={2}>{rowsLabel}</th>
                      {pivot.colKeys.map((c) => (
                        <th key={c} colSpan={nv}>{c}</th>
                      ))}
                      <th colSpan={nv}>Total</th>
                    </tr>
                    <tr>
                      {[...pivot.colKeys, "__TOTAL__"].map((c, ci) =>
                        vals.map((v, vi) => (
                          <th key={`${ci}-${vi}`}>
                            {v.agg} of {v.metric}
                          </th>
                        )),
                      )}
                    </tr>
                  </>
                ) : (
                  <tr>
                    <th className="drDim">{rowsLabel}</th>
                    {vals.map((v, vi) => (
                      <th key={vi}>
                        {v.agg} of {v.metric}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {pivot.rowKeys.map((r) => (
                  <tr key={r}>
                    <td className="drDim">{r}</td>
                    {pivot.colKeys.map((c) =>
                      vals.map((v, vi) => {
                        const sel = !!openCell && openCell.r === r && openCell.c === c && openCell.v === vi;
                        return (
                          <td key={`${c}-${vi}`} className={`drVal${sel ? " sel" : ""}`} onClick={() => toggleCell(r, c, vi)}>
                            {showVal(pivot.cells[r]?.[c]?.[vi] ?? null, v.metric)}
                          </td>
                        );
                      }),
                    )}
                    {hasCols &&
                      vals.map((v, vi) => {
                        const sel = !!openCell && openCell.r === r && openCell.c === "__all__" && openCell.v === vi;
                        return (
                          <td key={`tot-${vi}`} className={`drVal${sel ? " sel" : ""}`} onClick={() => toggleCell(r, "__all__", vi)}>
                            {showVal(pivot.rowTotals[r]?.[vi] ?? null, v.metric)}
                          </td>
                        );
                      })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="drDim">Grand total</td>
                  {pivot.colKeys.map((c, ci) =>
                    vals.map((v, vi) => (
                      <td key={`${ci}-${vi}`}>{showVal(pivot.colTotals[ci]?.[vi] ?? null, v.metric)}</td>
                    )),
                  )}
                  {hasCols &&
                    vals.map((v, vi) => <td key={`g-${vi}`}>{showVal(pivot.grandTotal[vi] ?? null, v.metric)}</td>)}
                </tr>
              </tfoot>
            </table>
          ) : (
            <div className="drHint">{loading ? "Loading the table…" : "No data."}</div>
          )}
        </div>

        {/* click-through drawer */}
        {openCell && drawerSpec ? (
          <div className="drDrawer">
            <div className="drDrawerH">
              <div>
                <strong>{cellData ? `${num(cellCount)} players` : "…"}</strong>
                <div className="drDm">
                  {drawerLabel} · {drawerSpec.agg} of {drawerSpec.metric} = {showVal(drawerValue, drawerSpec.metric)}
                </div>
              </div>
              <div className="drActions">
                <button type="button" className="drCsv" onClick={downloadCell} disabled={!cellData}>
                  Download {cellData ? num(cellCount) : ""} players
                </button>
                <button type="button" className="drGhost" onClick={() => setOpenCell(null)}>
                  Close
                </button>
              </div>
            </div>
            <div className="drPlist">
              <table className="drTable">
                <thead>
                  <tr>
                    <th className="drDim">Player ID</th>
                    <th>City</th>
                    <th>Field</th>
                    <th>Cohort</th>
                    <th>Months active</th>
                    <th>Spots</th>
                    <th>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {cellPlayers.map((p) => (
                    <tr key={p.id}>
                      <td className="drDim">{p.id}</td>
                      <td>{p.city}</td>
                      <td>{p.field}</td>
                      <td>{p.cohort}</td>
                      <td>{num(p.months)}</td>
                      <td>{num(p.spots)}</td>
                      <td>{money(p.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="drHint drHintFoot">Click any number above to see the players behind it.</div>
        )}

        {/* footnote */}
        <div className="drFoot">
          <b>Every number is clickable.</b> The table answers the question; clicking a cell gives you the players inside
          it, with their city, field and volume, ready to export and contact. <b>Average</b> is always per player, never
          per row of data.
        </div>
      </div>
    </div>
  );
}

const DR_CSS = `
.drRoot{color:${INK};font-variant-numeric:tabular-nums;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
.drCard{background:#fff;border:1px solid ${LINE};border-radius:14px;overflow:hidden}

.drHeadRow{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding:18px 22px;border-bottom:1px solid ${LINE}}
.drTitle{font-size:1.05rem;font-weight:800;letter-spacing:-.2px;color:${FOREST}}
.drSub{font-size:12px;color:${MUTED};margin-top:5px;line-height:1.45;max-width:900px}

.drPresets{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:13px 22px;
  background:${SLOT};border-bottom:1px solid ${LINE}}
.drPresetsL{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${MUTED};margin-right:6px}
.drPre{border:1px solid ${LINE};background:#fff;color:${FOREST};font-size:11.5px;font-weight:850;
  border-radius:99px;padding:7px 14px;cursor:pointer;font-family:inherit}
.drPre:hover{border-color:#bcc9c0}
.drPre.on{background:${FOREST};border-color:${FOREST};color:#fff}
.drPre:focus-visible{outline:2px solid ${FOREST};outline-offset:2px}

.drWells{display:grid;grid-template-columns:1fr 1fr 1.25fr;gap:14px;padding:16px 22px}
.drWell{border:1px solid ${LINE};border-radius:12px;padding:13px 14px;background:${SLOT};
  min-height:132px;display:flex;flex-direction:column}
.drWellH{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.drWellH b{font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${FOREST}}
.drWellH span{font-size:10px;color:${MUTED};font-weight:700}
.drChips{display:flex;flex-wrap:wrap;gap:7px;flex:1;align-content:flex-start;margin-bottom:10px}
.drChip{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid ${LINE};
  border-radius:9px;padding:6px 8px 6px 11px;font-size:11.5px;font-weight:850;color:${INK}}
.drChip select{border:1px solid ${LINE};border-radius:7px;padding:3px 6px;font-size:10.5px;
  font-weight:800;font-family:inherit;color:${INK};background:#fff;cursor:pointer}
.drChip button{border:0;background:transparent;color:${MUTED};cursor:pointer;font-size:14px;
  line-height:1;padding:0 2px;font-family:inherit}
.drChip button:hover:not(:disabled){color:#A83120}
.drChip button:disabled{opacity:.35;cursor:default}
.drAddrow{display:flex;gap:8px}
.drAddrow select{flex:1;min-width:0}
.drRoot select{font-family:inherit;font-size:12.5px;font-weight:700;color:${INK};background:#fff;
  border:1px solid ${LINE};border-radius:9px;padding:9px 11px;cursor:pointer}
.drRoot select:disabled{background:${SLOT};color:#8b978f;cursor:default}
.drAdd{border:1px solid ${LINE};background:#fff;color:${FOREST};font-size:11.5px;font-weight:900;
  border-radius:9px;padding:9px 14px;cursor:pointer;font-family:inherit;white-space:nowrap}
.drAdd:hover:not(:disabled){border-color:#bcc9c0}
.drAdd:disabled{opacity:.4;cursor:default}
.drRoot select:focus-visible,.drAdd:focus-visible,.drCsv:focus-visible,.drGhost:focus-visible{outline:2px solid ${FOREST};outline-offset:2px}

.drFilters{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;align-items:end;padding:4px 22px 18px}
.drFld label{display:block;font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;
  color:${MUTED};margin-bottom:6px}
.drFld select{width:100%}

.drRhead{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 22px;
  border-top:1px solid ${LINE};background:${SLOT}}
.drRhead strong{font-size:13.5px;font-weight:900;color:${FOREST}}
.drRmeta{font-size:11.5px;color:${MUTED};font-weight:700;margin-top:3px}
.drCsv{border:0;background:${YELLOW};color:${FOREST};font-size:12.5px;font-weight:900;
  padding:11px 20px;border-radius:10px;cursor:pointer;font-family:inherit;white-space:nowrap}
.drCsv:hover:not(:disabled){filter:brightness(.95)}
.drCsv:disabled{opacity:.5;cursor:default}

.drTwrap{overflow:auto;max-height:420px}
.drTable{width:100%;border-collapse:collapse}
.drTable th,.drTable td{padding:10px 14px;font-size:12.5px;text-align:right;border-bottom:1px solid ${LINE};
  font-variant-numeric:tabular-nums;white-space:nowrap}
.drTable th{font-size:9px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:${MUTED};
  background:#fff;position:sticky;top:0;z-index:2}
.drTable th.drDim,.drTable td.drDim{text-align:left;font-weight:850;color:${INK};background:#fff;position:sticky;left:0;z-index:1}
.drTable th.drDim{z-index:3}
.drTable td.drVal{cursor:pointer}
.drTable td.drVal:hover{background:${MINT_SOFT};box-shadow:inset 0 0 0 1px #A8E7C9}
.drTable td.drVal.sel{background:${MINT_SOFT};box-shadow:inset 0 0 0 2px ${MINT}}
.drTable tfoot td{background:${FOREST};color:#fff;font-weight:900;border:0;position:sticky;bottom:0;z-index:1}
.drTable tfoot td.drDim{background:${FOREST};color:#fff;z-index:2}

.drDrawer{border-top:1px solid ${LINE};background:${SLOT}}
.drDrawerH{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:15px 22px}
.drDrawerH strong{font-size:13.5px;font-weight:900;color:${FOREST}}
.drDm{font-size:11.5px;color:${MUTED};font-weight:700;margin-top:3px}
.drActions{display:flex;gap:9px;align-items:center}
.drGhost{border:1px solid ${LINE};background:#fff;color:${INK};font-size:11.5px;font-weight:850;
  border-radius:9px;padding:9px 15px;cursor:pointer;font-family:inherit}
.drGhost:hover{border-color:#bcc9c0}
.drPlist{max-height:280px;overflow:auto;background:#fff;border-top:1px solid ${LINE}}
.drPlist th{background:${SLOT}}

.drHint{padding:13px 22px;font-size:11.5px;color:${MUTED};font-weight:700;background:${SLOT}}
.drHintFoot{border-top:1px solid ${LINE}}
.drFoot{padding:14px 22px 18px;font-size:11px;color:${MUTED};line-height:1.6;max-width:1140px}
.drFoot b{color:${INK};font-weight:800}

@media (max-width:860px){
  .drWells{grid-template-columns:1fr}
  .drFilters{grid-template-columns:1fr 1fr}
}
`;
