"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fmtInt } from "./format";

// PART 6: potential churn. Reads /api/lifecycle/churn (growth_player_profile — one
// row per PLAYED player). The list is ranked server-side by MATCHES PLAYED desc,
// days-inactive breaking ties, so the most deeply-involved lapsed players surface
// first — NOT whoever has simply been gone longest. Rows arrive already ranked and
// are rendered as received (never re-sorted here). Two bounds define the window:
// "Inactive for" (30/60/90/120) is the staleness floor; "Last played after" is the
// recency ceiling. tiles + availableFields come back with the page; the CSV is
// streamed by the endpoint over the FULL filtered set (never assembled here).
const DAY_OPTIONS = [30, 60, 90, 120] as const;
const PAGE_SIZE = 12;
const HEAVY = 10;
const FIRST_MATCH = "2023-04-10"; // date-input min (first match ever)

type ChurnRow = { u: number; city: string; field: string; days: number; matches: number; last: string };
type ChurnResponse = {
  impossible: boolean;
  impliedDate: string;
  window: { after: string | null; before: string; days: number };
  tiles: { filteredPlayers: number; tenPlus: number; fields: number };
  total: number;
  rows: ChurnRow[];
  availableFields: string[];
  page: number;
  pageSize: number;
  days: number;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Format a "YYYY-MM-DD" string as "Jul 30, 2025" without going through Date()
// (which would shift the day across timezones).
function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${MON[m - 1]} ${d}, ${y}`;
}
function todayYmd(): string {
  const t = new Date();
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${mm}-${dd}`;
}

// Applied filters actually drive the fetch; staged filters wait for "Apply".
type Applied = { city: string; field: string; days: number; after: string; heavy: boolean; page: number };

function buildQuery(a: Applied): string {
  const sp = new URLSearchParams();
  sp.set("city", a.city);
  sp.set("field", a.field);
  sp.set("days", String(a.days));
  if (a.after) sp.set("after", a.after);
  if (a.heavy) sp.set("heavy", "1");
  sp.set("page", String(a.page));
  return sp.toString();
}

export default function ChurnPanel({
  cities,
  authHeaders,
  scopeChip,
}: {
  cities: string[];
  authHeaders: Record<string, string>;
  scopeChip?: ReactNode;
}) {
  const cityOptions = [{ label: "All Matchday", value: "all" }, ...cities.map((c) => ({ label: c, value: c }))];
  const maxDate = todayYmd();

  // Staged controls (edited freely, committed on Apply).
  const [sCity, setSCity] = useState("all");
  const [sField, setSField] = useState("all");
  const [sDays, setSDays] = useState<number>(90);
  const [sSince, setSSince] = useState<string>("");

  // Applied filters (drive the fetch).
  const [applied, setApplied] = useState<Applied>({
    city: "all",
    field: "all",
    days: 90,
    after: "",
    heavy: false,
    page: 0,
  });

  const [resp, setResp] = useState<ChurnResponse | null>(null);
  const [fields, setFields] = useState<string[]>([]); // city-narrowed field options
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/lifecycle/churn?${buildQuery(applied)}`, { headers: authHeaders })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return (await r.json()) as ChurnResponse;
      })
      .then((json) => {
        if (!alive) return;
        setResp(json);
        // Drive the Field dropdown from the response (city-narrowed, pre field/heavy
        // filter). Keep the last non-empty list so an impossible window — which comes
        // back with availableFields:[] — doesn't blank the dropdown.
        if (json.availableFields.length) setFields(json.availableFields);
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
  }, [applied, authHeaders]);

  const apply = useCallback(() => {
    setApplied({ city: sCity, field: sField, days: sDays, after: sSince, heavy: false, page: 0 });
  }, [sCity, sField, sDays, sSince]);

  const toggleHeavy = useCallback(() => {
    setApplied((a) => ({ ...a, heavy: !a.heavy, page: 0 }));
  }, []);

  const gotoPage = useCallback((p: number) => {
    setApplied((a) => ({ ...a, page: Math.max(0, p) }));
  }, []);

  async function downloadCsv() {
    const url = `/api/lifecycle/churn?${buildQuery(applied)}&format=csv`;
    const res = await fetch(url, { headers: authHeaders });
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = `potential-churn-${applied.days}d.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objUrl);
  }

  const rows = resp?.rows ?? [];
  const total = resp?.total ?? 0;
  const tiles = resp?.tiles ?? { filteredPlayers: 0, tenPlus: 0, fields: 0 };
  const impossible = resp?.impossible ?? false;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIdx = total === 0 ? 0 : applied.page * PAGE_SIZE + 1;
  const endIdx = Math.min(total, applied.page * PAGE_SIZE + rows.length);

  // Count line — states the actual window in words.
  let countLine: string;
  if (total === 0) {
    countLine = "No players match these filters.";
  } else {
    const win = applied.after
      ? `last played between ${fmtYmd(applied.after)} and ${fmtYmd(resp?.window.before)}`
      : `last played on or before ${fmtYmd(resp?.window.before)}`;
    countLine = `${fmtInt(total)} players, ${win}, ranked by matches played — showing ${fmtInt(
      startIdx,
    )}–${fmtInt(endIdx)}. The CSV has all of them.`;
  }

  return (
    <div className="mcChurn">
      <style>{CHURN_CSS}</style>
      <div className="card">
        <div className="head">
          <div>
            <div className="title">Potential churn players</div>
            <div className="sub">
              Filter inactive players by geography and time since last match, then export the resulting list.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            {scopeChip}
            <button type="button" className="csv" id="churnExport" onClick={downloadCsv}>
              Download CSV
            </button>
          </div>
        </div>

        <div className="filters">
          <div className="fld">
            <label htmlFor="growthChurnCity">City</label>
            <select
              id="growthChurnCity"
              value={sCity}
              onChange={(e) => {
                setSCity(e.target.value);
                setSField("all"); // field list is city-scoped; reset to All when city changes
              }}
            >
              {cityOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <label htmlFor="growthChurnField">Field</label>
            <select id="growthChurnField" value={sField} onChange={(e) => setSField(e.target.value)}>
              <option value="all">All fields</option>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <label htmlFor="growthChurnDays">Inactive for</label>
            <select
              id="growthChurnDays"
              value={sDays}
              onChange={(e) => setSDays(Number(e.target.value))}
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <label htmlFor="churnSince">Last played after</label>
            <input
              type="date"
              id="churnSince"
              min={FIRST_MATCH}
              max={maxDate}
              value={sSince}
              onChange={(e) => setSSince(e.target.value)}
            />
          </div>

          <button type="button" className="apply" id="churnApply" onClick={apply}>
            Apply filters
          </button>
        </div>

        <div id="warnHost">
          {error ? (
            <div className="warn">Could not load churn list: {error}</div>
          ) : impossible ? (
            <div className="warn">
              Those two filters leave no window: &ldquo;last played after {applied.after}&rdquo; is more recent than the{" "}
              {applied.days}-day staleness floor of {fmtYmd(resp?.impliedDate)}. Pick a date on or before{" "}
              {fmtYmd(resp?.impliedDate)}.
            </div>
          ) : null}
        </div>

        <div className="tiles" id="tiles">
          <div className="tile">
            <div className="tile-l">Filtered players</div>
            <div className="tile-v">{fmtInt(tiles.filteredPlayers)}</div>
            <div className="tile-f">inactive {applied.days}+ days</div>
          </div>
          <button
            type="button"
            className={`tile hl${applied.heavy ? " on" : ""}`}
            id="heavyTile"
            aria-pressed={applied.heavy}
            onClick={toggleHeavy}
          >
            <div className="tile-l">{HEAVY}+ prior matches</div>
            <div className="tile-v">{fmtInt(tiles.tenPlus)}</div>
            <div className="tile-f">
              {applied.heavy ? "showing these only · click to clear" : "click to show only these"}
            </div>
          </button>
          <div className="tile">
            <div className="tile-l">Fields represented</div>
            <div className="tile-v">{fmtInt(tiles.fields)}</div>
            <div className="tile-f">in the filtered list</div>
          </div>
        </div>

        {!impossible && !error && (
          <>
            <div className="count" id="countLine">
              {loading && !resp ? "Loading…" : countLine}
            </div>

            <div className="tableScroll">
              <table>
                <thead>
                  <tr>
                    <th>Player ID</th>
                    <th>City</th>
                    <th>Field</th>
                    <th>Days inactive</th>
                    <th>Matches played</th>
                    <th>Last played</th>
                  </tr>
                </thead>
                <tbody id="churnBody">
                  {rows.map((p) => (
                    <tr key={p.u} className={p.matches >= HEAVY ? "heavy" : undefined}>
                      <td className="pid">{p.u}</td>
                      <td>{p.city}</td>
                      <td>{p.field}</td>
                      <td>{fmtInt(p.days)}</td>
                      <td className="mp">{fmtInt(p.matches)}</td>
                      <td>{fmtYmd(p.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <span className="pinfo" id="pageInfo">
                Page {applied.page + 1} of {pageCount}
              </span>
              <div>
                <button
                  type="button"
                  className="pbtn"
                  id="prev"
                  onClick={() => gotoPage(applied.page - 1)}
                  disabled={loading || applied.page === 0}
                >
                  Prev
                </button>{" "}
                <button
                  type="button"
                  className="pbtn"
                  id="next"
                  onClick={() => gotoPage(applied.page + 1)}
                  disabled={loading || applied.page >= pageCount - 1}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}

        <div className="foot" id="churnNote">
          <b>Ranked by matches played, not by how long they have been gone.</b> A player who came {HEAVY}+ times and
          stopped is worth a call; someone who tried a single match two years ago is not — and sorting by days inactive
          would put that second group on page one. Days inactive only breaks ties, so the most deeply-involved lapsed
          players surface first. <b>{fmtInt(tiles.tenPlus)}</b> of the filtered list played {HEAVY} or more matches
          before going quiet; the <b>{HEAVY}+ prior matches</b> tile narrows to them. <b>Last played after</b> is the
          other end of the window — without it the list reaches back to the first match ever, and someone who played
          once in 2023 is not a win-back.
        </div>
      </div>
    </div>
  );
}

// Scoped to .mcChurn so the mockup's generic selectors (select, table, th, td …)
// can't leak into the rest of the Growth tab. Palette + structure are the mockup's.
const CHURN_CSS = `
.mcChurn{
  --forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;
  --line:#dfe4da;--slot:#F7F9F6;--yellow:#FFFF3E;
  --hlBg:#FFFAC9;--hlLine:#F2E9A0;--hlInk:#6B5A00;
  color:var(--ink);
  font-variant-numeric:tabular-nums;
}
.mcChurn *{box-sizing:border-box}
.mcChurn .card{background:var(--paper);border:1px solid var(--line);border-radius:14px;
  overflow:hidden;padding:0}
.mcChurn .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding:18px 22px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.mcChurn .title{font-size:1.05rem;font-weight:800;letter-spacing:-.2px;color:var(--forest)}
.mcChurn .sub{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.45;max-width:60ch}
.mcChurn .csv{border:0;background:var(--yellow);color:var(--forest);font-size:12.5px;font-weight:800;
  padding:11px 20px;border-radius:10px;cursor:pointer;font-family:inherit;white-space:nowrap}
.mcChurn .csv:hover{filter:brightness(.95)}

.mcChurn .filters{display:grid;grid-template-columns:1fr 1.4fr .9fr 1fr auto;gap:14px;align-items:end;
  padding:16px 22px;border-bottom:1px solid var(--line)}
@media (max-width:820px){.mcChurn .filters{grid-template-columns:1fr 1fr}}
.mcChurn .fld label{display:block;font-size:9px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;
  color:var(--muted);margin-bottom:6px}
.mcChurn select,.mcChurn input[type=date]{width:100%;font-family:inherit;font-size:13px;font-weight:700;
  color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:11px 13px;cursor:pointer}
.mcChurn .warn{margin:14px 22px 0;padding:11px 14px;border-radius:10px;background:#FFE0DA;
  border:1px solid #F5C6BC;color:#8f2d15;font-size:11.5px;font-weight:800;line-height:1.5}
.mcChurn .apply{border:0;background:var(--forest);color:#fff;font-size:12.5px;font-weight:800;
  padding:12px 24px;border-radius:10px;cursor:pointer;font-family:inherit;white-space:nowrap}
.mcChurn .apply:hover{background:#00281e}

.mcChurn .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px 22px;
  border-bottom:1px solid var(--line)}
@media (max-width:640px){.mcChurn .tiles{grid-template-columns:1fr}}
.mcChurn .tile{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--slot);
  text-align:left;font-family:inherit;cursor:default}
.mcChurn .tile-l{font-size:9.5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.mcChurn .tile-v{font-size:26px;font-weight:800;color:var(--forest);margin-top:7px;line-height:1}
.mcChurn .tile-f{font-size:10.5px;color:var(--muted);font-weight:650;margin-top:6px}
.mcChurn .tile.hl{background:var(--hlBg);border-color:var(--hlLine);cursor:pointer;width:100%}
.mcChurn .tile.hl .tile-l{color:var(--hlInk)}
.mcChurn .tile.hl:hover{filter:brightness(.985)}
.mcChurn .tile.hl.on{box-shadow:inset 0 0 0 2px var(--forest)}

.mcChurn .count{padding:12px 22px;font-size:11.5px;color:var(--muted);font-weight:700;
  border-bottom:1px solid var(--line)}

.mcChurn .tableScroll{overflow-x:auto}
.mcChurn table{width:100%;border-collapse:collapse}
.mcChurn th,.mcChurn td{padding:12px 16px;font-size:12.5px;text-align:right;border-bottom:1px solid var(--line);
  white-space:nowrap}
.mcChurn th{font-size:9px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);
  background:var(--slot)}
.mcChurn th:first-child,.mcChurn td:first-child,.mcChurn th:nth-child(2),.mcChurn td:nth-child(2),
.mcChurn th:nth-child(3),.mcChurn td:nth-child(3){text-align:left}
.mcChurn td.pid{font-weight:800;color:var(--forest)}
.mcChurn tbody tr:hover{background:#fbfcfa}
.mcChurn tr.heavy td.mp{color:var(--hlInk);font-weight:800}
.mcChurn tr.heavy td.pid::after{content:"heavy";display:inline-block;margin-left:9px;font-size:8.5px;
  font-weight:800;letter-spacing:.4px;text-transform:uppercase;background:var(--hlBg);
  border:1px solid var(--hlLine);color:var(--hlInk);border-radius:5px;padding:1px 6px;vertical-align:1px}

.mcChurn .pager{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 22px}
.mcChurn .pbtn{border:1px solid var(--line);background:#fff;color:var(--ink);font-size:12px;font-weight:800;
  border-radius:9px;padding:8px 16px;cursor:pointer;font-family:inherit}
.mcChurn .pbtn[disabled]{opacity:.4;cursor:default}
.mcChurn .pinfo{font-size:11.5px;font-weight:800;color:var(--muted)}
.mcChurn .foot{padding:16px 22px 18px;font-size:11px;color:var(--muted);line-height:1.6;max-width:1100px}
.mcChurn .foot b{color:var(--ink);font-weight:800}
`;
