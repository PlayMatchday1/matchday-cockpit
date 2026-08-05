"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  axisMaxAge,
  curveFull,
  cohortsObservedAt,
  type CohortMatrixPayload,
  type FullCurvePoint,
} from "./retentionModel";

// Retention curve — each point is the unweighted mean of a first-match cohort's
// retention at that age, over the cohorts old enough to be observed there. The
// x-axis runs from month 0 to the network span (axisMaxAge, months since the
// first match ever); each city's line stops at ITS own oldest cohort. The
// all-cities rollup is the incoming payload ("All Matchday"); a city selection
// refetches /api/growth/retention?city=<display> and is cached.
const NETWORK = "All Matchday";
// New York City (a single-cohort non-market) is dropped from the selector.
const HIDDEN_CITIES = new Set(["New York City", "NYC"]);

// Palette (spec): fill-only lines never carry small text.
const FOREST = "#003326";
const MINT = "#2CDB87"; // primary line stroke
const BLUE = "#2E79FF"; // comparison line stroke
const BLUE_INK = "#1B5FD9"; // comparison small text (AA on white)
const MUTED = "#5C6B62";
const INK = "#0d1f18";
const CREAM = "#F4EEE1";
const LINE = "#dfe4da";

// Chart geometry (viewBox 1300×420), ported verbatim from the mockup.
const VW = 1300;
const VH = 420;
const M = { l: 64, r: 26, t: 20, b: 52 };
const IW = VW - M.l - M.r;
const IH = VH - M.t - M.b;
const THIN = 12; // fewer than this many cohorts = thin tail

type Descriptor = { name: string; color: string; isNet: boolean };

export default function RetentionCurvePanel({
  payload,
  authHeaders,
  scopeChip,
}: {
  payload: CohortMatrixPayload;
  authHeaders: Record<string, string>;
  scopeChip?: ReactNode;
}) {
  // City options: payload.cities minus the non-market entries, "All Matchday" first.
  const cityNames = useMemo(
    () => payload.cities.filter((c) => !HIDDEN_CITIES.has(c)),
    [payload.cities],
  );
  const options = useMemo(() => [NETWORK, ...cityNames], [cityNames]);

  const [primary, setPrimary] = useState(NETWORK);
  const [compareOn, setCompareOn] = useState(true);
  const [secondary, setSecondary] = useState(
    cityNames.includes("Austin") ? "Austin" : cityNames[0] ?? NETWORK,
  );
  // Per-city payloads fetched on demand; the all-cities rollup is the prop.
  const [cityPayloads, setCityPayloads] = useState<Record<string, CohortMatrixPayload>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const wanted = [primary, compareOn ? secondary : null].filter(
      (n): n is string => !!n && n !== NETWORK && !(n in cityPayloads),
    );
    if (!wanted.length) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const fetched = await Promise.all(
          wanted.map(async (name) => {
            const res = await fetch(`/api/growth/retention?city=${encodeURIComponent(name)}`, {
              headers: authHeaders,
            });
            return [name, (await res.json()) as CohortMatrixPayload] as const;
          }),
        );
        if (alive) setCityPayloads((prev) => ({ ...prev, ...Object.fromEntries(fetched) }));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [primary, secondary, compareOn, authHeaders, cityPayloads]);

  const payloadFor = (name: string): CohortMatrixPayload | null =>
    name === NETWORK ? payload : cityPayloads[name] ?? null;

  const primaryPayload = payloadFor(primary);
  const secondaryPayload =
    compareOn && secondary !== primary ? payloadFor(secondary) : null;

  const primaryCurve = useMemo(
    () => (primaryPayload ? curveFull(primaryPayload) : null),
    [primaryPayload],
  );
  const secondaryCurve = useMemo(
    () => (secondaryPayload ? curveFull(secondaryPayload) : null),
    [secondaryPayload],
  );

  // Axis maximum comes from the NETWORK payload (months since the first match
  // ever) — never a literal. For the current data this is 40.
  const axisMax = useMemo(() => axisMaxAge(payload), [payload]);

  // Thin-tail boundary: smallest age where fewer than 12 cohorts are observable,
  // measured on the NETWORK payload.
  const thinFrom = useMemo(() => {
    for (let n = 0; n <= axisMax; n++) if (cohortsObservedAt(payload, n) < THIN) return n;
    return axisMax + 1;
  }, [payload, axisMax]);

  const xAt = (n: number) => M.l + IW * (n / axisMax);
  const yAt = (v: number) => M.t + IH * (1 - v / 100);

  // Series drawn: primary (mint) always; comparison (blue) only when compare is
  // on and it differs from the primary. The two never share a colour.
  const drawn: Descriptor[] = [{ name: primary, color: MINT, isNet: primary === NETWORK }];
  if (compareOn && secondary !== primary)
    drawn.push({ name: secondary, color: BLUE, isNet: secondary === NETWORK });

  const curveFor = (name: string): FullCurvePoint[] | null =>
    name === primary ? primaryCurve : name === secondary ? secondaryCurve : null;

  const at = (curve: FullCurvePoint[] | null, n: number): FullCurvePoint | null =>
    curve ? curve.find((p) => p.age === n) ?? null : null;
  const lastAgeOf = (curve: FullCurvePoint[] | null): number | null =>
    curve && curve.length ? curve[curve.length - 1].age : null;

  const pathD = (curve: FullCurvePoint[]) =>
    curve
      .map((p, i) => `${i ? "L" : "M"}${xAt(p.age).toFixed(1)},${yAt(p.pct).toFixed(1)}`)
      .join(" ");

  // X ticks: every 5 months, plus the final month if it is not a multiple of 5.
  const xTicks = useMemo(() => {
    const t: number[] = [];
    for (let n = 0; n <= axisMax; n += 5) t.push(n);
    if (axisMax % 5 !== 0) t.push(axisMax);
    return t;
  }, [axisMax]);

  const compareText = drawn.length > 1;
  const sub = compareText
    ? `${primary} compared with ${secondary} · retention by month since first match`
    : `${primary} · retention by month since first match`;

  // Footnote: any drawn series whose line ends before the axis max, with why.
  const shortClauses = drawn
    .map((d) => ({ d, last: lastAgeOf(curveFor(d.name)) }))
    .filter((x): x is { d: Descriptor; last: number } => x.last != null && x.last < axisMax)
    .map(({ d, last }) =>
      d.isNet
        ? `${d.name} stops at month ${last} (its two oldest cohorts were free-launch promos, excluded)`
        : `${d.name} stops at month ${last} — no cohort old enough to go further`,
    );

  const netAt1 = cohortsObservedAt(payload, 1);
  const netAtMax = cohortsObservedAt(payload, axisMax);

  return (
    <div className="rcvRoot">
      <style>{RCV_CSS}</style>
      <div className="rcvCard">
        <div className="rcvHead">
          <div>
            <div className="rcvTitle">Retention curve</div>
            <div className="rcvSub" id="retentionSub">
              {sub}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
          <div className="rcvControls">
            <div className="rcvField">
              <label htmlFor="retentionCityA">Primary city</label>
              <select
                className="rcvSelect"
                id="retentionCityA"
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
              >
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={`rcvToggle${compareOn ? " active" : ""}`}
              id="retentionCompare"
              aria-pressed={compareOn}
              onClick={() => setCompareOn((v) => !v)}
            >
              Compare
            </button>
            <div
              className={`rcvField${compareOn ? "" : " rcvHidden"}`}
              id="retentionCompareField"
            >
              <label htmlFor="retentionCityB">Comparison city</label>
              <select
                className="rcvSelect"
                id="retentionCityB"
                value={secondary}
                onChange={(e) => setSecondary(e.target.value)}
              >
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          </div>
        </div>

        <div className="rcvChart">
          <svg
            id="retentionChart"
            viewBox={`0 0 ${VW} ${VH}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* thin-sample region */}
            {thinFrom <= axisMax && (
              <>
                <rect
                  x={xAt(thinFrom).toFixed(1)}
                  y={M.t}
                  width={(xAt(axisMax) - xAt(thinFrom)).toFixed(1)}
                  height={IH}
                  fill={CREAM}
                  opacity={0.55}
                />
                <line
                  x1={xAt(thinFrom).toFixed(1)}
                  y1={M.t}
                  x2={xAt(thinFrom).toFixed(1)}
                  y2={M.t + IH}
                  stroke="#c9cfc6"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text
                  className="rcvAxis"
                  x={(xAt(thinFrom) + 7).toFixed(1)}
                  y={M.t + 14}
                  style={{ fontSize: "9.5px" }}
                >
                  fewer than {THIN} cohorts
                </text>
              </>
            )}

            {/* Y gridlines + labels */}
            {[0, 25, 50, 75, 100].map((t) => (
              <g key={`y${t}`}>
                <line
                  className="rcvGl"
                  x1={M.l}
                  y1={yAt(t).toFixed(1)}
                  x2={M.l + IW}
                  y2={yAt(t).toFixed(1)}
                />
                <text
                  className="rcvAxis"
                  x={M.l - 12}
                  y={(yAt(t) + 3.6).toFixed(1)}
                  textAnchor="end"
                >
                  {t}%
                </text>
              </g>
            ))}

            {/* X ticks + axis title */}
            {xTicks.map((n) => (
              <text
                key={`x${n}`}
                className="rcvAxis"
                x={xAt(n).toFixed(1)}
                y={VH - M.b + 26}
                textAnchor="middle"
              >
                {n}
              </text>
            ))}
            <text
              className="rcvAxis"
              x={(M.l + IW / 2).toFixed(1)}
              y={VH - 6}
              textAnchor="middle"
              style={{ fontSize: "10px" }}
            >
              Months since first match
            </text>

            {/* series */}
            {drawn.map((d) => {
              const curve = curveFor(d.name);
              if (!curve || !curve.length) return null;
              const last = curve[curve.length - 1];
              return (
                <g key={d.name}>
                  <path
                    d={pathD(curve)}
                    fill="none"
                    stroke={d.color}
                    strokeWidth={2.6}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <circle cx={xAt(0)} cy={yAt(curve[0].pct)} r={3.6} fill={d.color} />
                  <circle
                    cx={xAt(last.age).toFixed(1)}
                    cy={yAt(last.pct).toFixed(1)}
                    r={3.6}
                    fill={d.color}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        <div className="rcvLegend" id="retentionLegend">
          {drawn.map((d) => (
            <span key={d.name}>
              <i className="rcvDot" style={{ background: d.color }} />
              {d.name}
            </span>
          ))}
        </div>

        <div className="rcvMiles" id="miles">
          {[1, 3, 6, 12].map((n) => {
            const a = at(primaryCurve, n);
            const b = compareText ? at(secondaryCurve, n) : null;
            const count = primaryPayload ? cohortsObservedAt(primaryPayload, n) : null;
            return (
              <div className="rcvMile" key={n}>
                <div className="rcvMileL">Month {n}</div>
                <div className="rcvMileRow">
                  <span className="rcvMileV">{a ? `${a.pct.toFixed(1)}%` : "—"}</span>
                  {b && (
                    <span className="rcvMileB">
                      {secondary} {b.pct.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="rcvMileF">
                  {count != null ? `${count} cohorts observed` : "…"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="rcvFoot" id="retFoot">
          {loading && <>Loading city curve… · </>}
          <b>Each point is the share of a first-match cohort still playing that many months later</b>, averaged
          across every cohort old enough to be observed at that age — so month 1 draws on {netAt1} cohorts and
          month {axisMax} on {netAtMax}.{" "}
          {thinFrom <= axisMax && (
            <>
              <b>The shaded tail</b> past month {thinFrom} rests on fewer than {THIN} cohorts and moves on small
              numbers; read the trend there, not the wiggles.{" "}
            </>
          )}
          {shortClauses.length > 0 && <b>{shortClauses.join("; ")}.</b>}
        </div>
      </div>
    </div>
  );
}

const RCV_CSS = `
.rcvRoot{color:${INK};font-variant-numeric:tabular-nums}
.rcvCard{background:#fff;border:1px solid ${LINE};border-radius:14px;overflow:hidden}
.rcvHead{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;padding:18px 22px 12px;flex-wrap:wrap}
.rcvTitle{font-size:1.05rem;font-weight:800;letter-spacing:-.2px;color:${FOREST}}
.rcvSub{font-size:12px;color:${MUTED};margin-top:5px;line-height:1.45}
.rcvControls{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.rcvField label{display:block;font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${MUTED};margin-bottom:5px}
.rcvSelect{font-family:inherit;font-size:12px;font-weight:750;color:${INK};background:#fff;border:1px solid ${LINE};border-radius:10px;padding:9px 12px;cursor:pointer;min-width:150px}
.rcvToggle{border:1px solid ${LINE};background:#fff;color:${FOREST};font-size:12px;font-weight:850;padding:9px 18px;border-radius:10px;cursor:pointer;font-family:inherit}
.rcvToggle:hover{background:${"#EFF4EF"}}
.rcvToggle.active{background:${FOREST};border-color:${FOREST};color:#fff}
.rcvToggle:focus-visible,.rcvSelect:focus-visible{outline:2px solid ${FOREST};outline-offset:2px}
.rcvHidden{display:none}
.rcvChart{padding:2px 12px 0}
.rcvChart svg{display:block;width:100%;height:auto;overflow:visible}
.rcvAxis{font-size:10.5px;fill:${MUTED};font-weight:700}
.rcvGl{stroke:${LINE};stroke-width:1}
.rcvLegend{display:flex;gap:26px;padding:12px 22px 4px;flex-wrap:wrap}
.rcvLegend span{font-size:11.5px;font-weight:850;color:${INK};display:inline-flex;align-items:center}
.rcvDot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}
.rcvMiles{display:flex;border-top:1px solid ${LINE};margin-top:12px;flex-wrap:wrap}
.rcvMile{flex:1;min-width:120px;padding:13px 22px;border-right:1px solid ${LINE}}
.rcvMile:last-child{border-right:0}
.rcvMileL{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:${MUTED}}
.rcvMileRow{display:flex;align-items:baseline;gap:9px;margin-top:6px;flex-wrap:wrap}
.rcvMileV{font-size:18px;font-weight:900;color:${FOREST};line-height:1;font-variant-numeric:tabular-nums}
.rcvMileB{font-size:12px;font-weight:850;color:${BLUE_INK};font-variant-numeric:tabular-nums}
.rcvMileF{font-size:10.5px;color:${MUTED};margin-top:5px;font-weight:650}
.rcvFoot{padding:14px 22px 18px;font-size:11px;color:${MUTED};line-height:1.6}
.rcvFoot b{color:${INK};font-weight:800}
`;
