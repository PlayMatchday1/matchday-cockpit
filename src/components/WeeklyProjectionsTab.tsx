"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  computeProjections,
  computeProjectionWindows,
  deleteProjection,
  fetchProjectionsData,
  fetchSavedProjections,
  saveProjection,
  type CityProjection,
  type FieldProjectionRow,
  type ProjectionsView,
  type RegistrationRow,
  type WeekWindow,
} from "@/lib/projectionsStats";

// Debounce window for inline edits — saves an upsert ~300ms after the
// last keystroke so back-to-back digit changes don't fire one round-
// trip per character.
const SAVE_DEBOUNCE_MS = 300;

function fmtUsd(n: number): string {
  if (Math.round(n) === 0) return "$0";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function fmtUsdDec(n: number): string {
  return "$" + n.toFixed(2);
}
function fmtSig(n: number): string {
  if (Math.round(n) === 0) return "$0";
  const abs = Math.abs(Math.round(n)).toLocaleString("en-US");
  return n > 0 ? `+$${abs}` : `-$${abs}`;
}
function pctSig(num: number, denom: number): string {
  if (denom === 0) {
    return num === 0 ? "0%" : "—";
  }
  const pct = (num / denom) * 100;
  const r = Math.round(pct);
  if (r === 0) return "0%";
  return r > 0 ? `+${r}%` : `${r}%`;
}
// Tone for revenue Δ: mint = up = good, coral = down = bad, muted = 0.
function revenueDeltaTone(delta: number): string {
  const r = Math.round(delta);
  if (r === 0) return "text-deep-green/55";
  return r > 0 ? "text-mint-hover" : "text-coral";
}

// Resolve effective per-spot price for the rev calc. null defaults
// (no W-1 DPP activity) collapse to 0 — the input renders empty until
// the operator types a price; the math just contributes nothing to
// totals in the meantime.
function resolvePricePerSpot(
  state: { avgPricePerSpotPlanned: number | null } | undefined,
  row: FieldProjectionRow,
): number {
  return (
    state?.avgPricePerSpotPlanned ?? row.defaults.avgPricePerSpot ?? 0
  );
}

export default function WeeklyProjectionsTab() {
  const [view, setView] = useState<ProjectionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Local edit cache: keyed by venueId. Stores the in-flight + saved
  // values without re-fetching the world after each upsert. Three
  // planning levers: matches, dpp spots, avg price/spot. Rev is
  // derived (dppSpots × pricePerSpot); avg/match is derived
  // (rev / matches).
  type RowState = {
    matchesPlanned: number | null;
    dppSpotsPlanned: number | null;
    avgPricePerSpotPlanned: number | null;
  };
  const [rowState, setRowState] = useState<Map<number, RowState>>(
    new Map(),
  );

  const debounceTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const windows = computeProjectionWindows();
      const [{ registrations, venues }, saved] = await Promise.all([
        fetchProjectionsData(supabase),
        fetchSavedProjections(supabase, windows.nextWindow.start),
      ]);
      const v = computeProjections(registrations, venues, saved, windows);
      setView(v);
      // Hydrate rowState from the saved values returned by compute.
      const next = new Map<number, RowState>();
      for (const c of v.cities) {
        for (const f of c.fields) {
          next.set(f.venueId, {
            matchesPlanned: f.saved.matchesPlanned,
            dppSpotsPlanned: f.saved.dppSpotsPlanned,
            avgPricePerSpotPlanned: f.saved.avgPricePerSpotPlanned,
          });
        }
      }
      setRowState(next);
      // Default-collapse all cities except the first — keeps the page
      // tidy on initial load. Click to expand.
      setCollapsed(new Set(v.cities.slice(1).map((c) => c.city)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      // Clear any pending debounced saves on unmount.
      for (const t of debounceTimers.current.values()) clearTimeout(t);
      debounceTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const EMPTY_ROW_STATE: RowState = {
    matchesPlanned: null,
    dppSpotsPlanned: null,
    avgPricePerSpotPlanned: null,
  };

  function scheduleSave(venueId: number, weekStart: string) {
    const existing = debounceTimers.current.get(venueId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      const state = rowState.get(venueId);
      if (!state) return;
      try {
        await saveProjection(supabase, {
          venueId,
          weekStartDate: weekStart,
          matchesPlanned: state.matchesPlanned,
          dppSpotsPlanned: state.dppSpotsPlanned,
          avgPricePerSpotPlanned: state.avgPricePerSpotPlanned,
        });
      } catch (e) {
        // Surface but don't reset local state — operator can retry
        // by editing again.
        console.error("Save projection failed:", e);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, SAVE_DEBOUNCE_MS);
    debounceTimers.current.set(venueId, t);
  }

  function handleMatchesChange(venueId: number, raw: string) {
    if (!view) return;
    const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
    setRowState((prev) => {
      const next = new Map(prev);
      const cur = next.get(venueId) ?? EMPTY_ROW_STATE;
      next.set(venueId, {
        ...cur,
        matchesPlanned: Number.isFinite(parsed as number) ? parsed : null,
      });
      return next;
    });
    scheduleSave(venueId, view.nextWindow.start);
  }

  function handleDppSpotsChange(venueId: number, raw: string) {
    if (!view) return;
    const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
    setRowState((prev) => {
      const next = new Map(prev);
      const cur = next.get(venueId) ?? EMPTY_ROW_STATE;
      next.set(venueId, {
        ...cur,
        dppSpotsPlanned: Number.isFinite(parsed as number) ? parsed : null,
      });
      return next;
    });
    scheduleSave(venueId, view.nextWindow.start);
  }

  function handleAvgPricePerSpotChange(venueId: number, raw: string) {
    if (!view) return;
    const parsed = raw === "" ? null : Math.max(0, Number(raw));
    setRowState((prev) => {
      const next = new Map(prev);
      const cur = next.get(venueId) ?? EMPTY_ROW_STATE;
      next.set(venueId, {
        ...cur,
        avgPricePerSpotPlanned: Number.isFinite(parsed as number)
          ? parsed
          : null,
      });
      return next;
    });
    scheduleSave(venueId, view.nextWindow.start);
  }

  async function handleReset(venueId: number) {
    if (!view) return;
    // Cancel any pending debounce.
    const existing = debounceTimers.current.get(venueId);
    if (existing) clearTimeout(existing);
    debounceTimers.current.delete(venueId);
    // Optimistic local update — clear all 3 planning inputs.
    setRowState((prev) => {
      const next = new Map(prev);
      next.set(venueId, EMPTY_ROW_STATE);
      return next;
    });
    try {
      await deleteProjection(supabase, {
        venueId,
        weekStartDate: view.nextWindow.start,
      });
    } catch (e) {
      console.error("Delete projection failed:", e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleCity(city: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }

  if (loading && !view) {
    return (
      <p className="text-sm text-deep-green/60">Loading projections…</p>
    );
  }
  if (error && !view) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft p-4 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!view) return null;

  // Compute grand totals using the latest local state. Projected rev
  // is dpp spots × price/spot — the new model — for both city + grand.
  const grandW1 = view.cities.reduce(
    (s, c) => s + c.fields.reduce((s2, f) => s2 + f.weeks[3].dppRev, 0),
    0,
  );
  const grandNext = view.cities.reduce(
    (s, c) =>
      s +
      c.fields.reduce((s2, f) => {
        const st = rowState.get(f.venueId);
        const spots = st?.dppSpotsPlanned ?? f.defaults.dppSpots;
        const price = resolvePricePerSpot(st, f);
        return s2 + (spots ?? 0) * price;
      }, 0),
    0,
  );
  const grandDelta = grandNext - grandW1;

  return (
    <>
      <div className="mb-6">
        <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green md:text-4xl">
          Weekly Projections
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
          Plan next week field-by-field. Compare against the last 4 weeks
          of actuals.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft px-4 py-3 text-sm text-coral">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {view.cities.map((c) => (
          <CityCard
            key={c.city}
            city={c}
            view={view}
            rowState={rowState}
            collapsed={collapsed.has(c.city)}
            onToggle={() => toggleCity(c.city)}
            onMatchesChange={handleMatchesChange}
            onDppSpotsChange={handleDppSpotsChange}
            onAvgPricePerSpotChange={handleAvgPricePerSpotChange}
            onReset={handleReset}
          />
        ))}
      </div>

      <div className="mt-6 rounded-2xl border-l-4 border-mint border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-mint-hover">
              Grand total · all cities
            </h3>
            <p className="mt-0.5 text-[11px] text-deep-green/55">
              W-1 ({view.windowsHistorical[3].label}) actual vs Next (
              {view.nextWindow.label}) projected
            </p>
          </div>
          <div className="flex items-baseline gap-3 font-mono text-base tabular-nums">
            <span className="text-deep-green/65">{fmtUsd(grandW1)}</span>
            <span aria-hidden className="text-deep-green/35">
              →
            </span>
            <span className="text-deep-green">{fmtUsd(grandNext)}</span>
            <span className={`font-bold ${revenueDeltaTone(grandDelta)}`}>
              {fmtSig(grandDelta)}
            </span>
            <span
              className={`text-xs font-semibold ${revenueDeltaTone(grandDelta)}`}
            >
              ({pctSig(grandDelta, grandW1)})
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

type CellRowState = {
  matchesPlanned: number | null;
  dppSpotsPlanned: number | null;
  avgPricePerSpotPlanned: number | null;
};

function CityCard({
  city,
  view,
  rowState,
  collapsed,
  onToggle,
  onMatchesChange,
  onDppSpotsChange,
  onAvgPricePerSpotChange,
  onReset,
}: {
  city: CityProjection;
  view: ProjectionsView;
  rowState: Map<number, CellRowState>;
  collapsed: boolean;
  onToggle: () => void;
  onMatchesChange: (venueId: number, raw: string) => void;
  onDppSpotsChange: (venueId: number, raw: string) => void;
  onAvgPricePerSpotChange: (venueId: number, raw: string) => void;
  onReset: (venueId: number) => void;
}) {
  // City totals based on current rowState (live recompute). Projected
  // rev = Σ (dppSpots × pricePerSpot) — matches the per-row math.
  const cityW1 = city.fields.reduce((s, f) => s + f.weeks[3].dppRev, 0);
  const cityNext = city.fields.reduce((s, f) => {
    const st = rowState.get(f.venueId);
    const spots = st?.dppSpotsPlanned ?? f.defaults.dppSpots;
    const price = resolvePricePerSpot(st, f);
    return s + (spots ?? 0) * price;
  }, 0);
  const cityDelta = cityNext - cityW1;

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-cream-soft/40"
      >
        {collapsed ? (
          <ChevronRight size={18} aria-hidden className="text-deep-green/55" />
        ) : (
          <ChevronDown size={18} aria-hidden className="text-deep-green/55" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold text-deep-green">{city.city}</div>
          <p className="mt-0.5 text-[11px] text-deep-green/55">
            {city.fields.length}{" "}
            {city.fields.length === 1 ? "field" : "fields"}
          </p>
        </div>
        <div className="hidden items-baseline gap-2 font-mono text-sm tabular-nums sm:flex">
          <span className="text-deep-green/55">{fmtUsd(cityW1)}</span>
          <span aria-hidden className="text-deep-green/35">→</span>
          <span className="text-deep-green">{fmtUsd(cityNext)}</span>
          <span className={`font-bold ${revenueDeltaTone(cityDelta)}`}>
            {fmtSig(cityDelta)}
          </span>
        </div>
      </button>

      {!collapsed && (
        <div className="overflow-x-auto border-t border-cream-line">
          <table className="w-full text-[12px]">
            <thead className="bg-cream-soft/60 text-[10px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
              <tr>
                <th className="px-3 py-2 text-left">Field</th>
                {view.windowsHistorical.map((w, i) => (
                  <th key={w.start} className="px-2 py-2 text-right">
                    W-{4 - i}
                    <div className="text-[9px] font-normal normal-case tracking-normal text-deep-green/45">
                      {w.label}
                    </div>
                  </th>
                ))}
                <th className="px-2 py-2 text-right text-mint-hover">
                  Next
                  <div className="text-[9px] font-normal normal-case tracking-normal text-deep-green/45">
                    {view.nextWindow.label}
                  </div>
                </th>
                <th className="px-3 py-2 text-right">Δ vs W-1</th>
              </tr>
            </thead>
            <tbody>
              {city.fields.map((f) => (
                <FieldRow
                  key={f.venueId}
                  row={f}
                  state={rowState.get(f.venueId)}
                  onMatchesChange={onMatchesChange}
                  onDppSpotsChange={onDppSpotsChange}
                  onAvgPricePerSpotChange={onAvgPricePerSpotChange}
                  onReset={onReset}
                />
              ))}
            </tbody>
            <tfoot className="bg-cream-soft/40 text-[11px] font-semibold text-deep-green">
              <tr className="border-t border-cream-line">
                <td className="px-3 py-2 text-left">{city.city} total</td>
                <td colSpan={3} className="px-2 py-2 text-right text-deep-green/55">
                  {/* Spanning W-4..W-3..W-2 numerically would be noisy; leave blank. */}
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">
                  {fmtUsd(cityW1)}
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">
                  {fmtUsd(cityNext)}
                </td>
                <td className={`px-3 py-2 text-right font-mono font-bold tabular-nums ${revenueDeltaTone(cityDelta)}`}>
                  {fmtSig(cityDelta)}{" "}
                  <span className="font-normal text-[10px]">
                    ({pctSig(cityDelta, cityW1)})
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function FieldRow({
  row,
  state,
  onMatchesChange,
  onDppSpotsChange,
  onAvgPricePerSpotChange,
  onReset,
}: {
  row: FieldProjectionRow;
  state: CellRowState | undefined;
  onMatchesChange: (venueId: number, raw: string) => void;
  onDppSpotsChange: (venueId: number, raw: string) => void;
  onAvgPricePerSpotChange: (venueId: number, raw: string) => void;
  onReset: (venueId: number) => void;
}) {
  const matches = state?.matchesPlanned ?? row.defaults.matches;
  const dppSpots = state?.dppSpotsPlanned ?? row.defaults.dppSpots;
  // Price-per-spot input: render whatever's in state if set, else the
  // W-1 default, else empty (no W-1 DPP activity to fall back on).
  const pricePerSpotForInput =
    state?.avgPricePerSpotPlanned ?? row.defaults.avgPricePerSpot;
  const pricePerSpotForCalc = pricePerSpotForInput ?? 0;
  const projected = (dppSpots ?? 0) * pricePerSpotForCalc;
  // avg/match is now a derived display, not an input.
  const avgPerMatch =
    matches && matches > 0 ? projected / matches : 0;

  const isEdited =
    state?.matchesPlanned != null ||
    state?.dppSpotsPlanned != null ||
    state?.avgPricePerSpotPlanned != null;

  const w1 = row.weeks[3];
  const matchDelta = (matches ?? 0) - w1.matches;
  const spotsDelta = (dppSpots ?? 0) - w1.dppSpots;
  const dppDelta = projected - w1.dppRev;
  const matchDeltaTone =
    matchDelta === 0
      ? "text-deep-green/45"
      : matchDelta > 0
        ? "text-mint-hover"
        : "text-coral";
  const matchDeltaStr =
    matchDelta > 0
      ? `+${matchDelta}`
      : matchDelta === 0
        ? "0"
        : `${matchDelta}`;
  const spotsDeltaTone =
    spotsDelta === 0
      ? "text-deep-green/45"
      : spotsDelta > 0
        ? "text-mint-hover"
        : "text-coral";
  const spotsDeltaStr =
    spotsDelta > 0
      ? `+${spotsDelta}`
      : spotsDelta === 0
        ? "0"
        : `${spotsDelta}`;

  return (
    <tr className="border-t border-cream-line/60">
      <td className="px-3 py-2 align-top text-deep-green">{row.venueName}</td>
      {row.weeks.map((w, i) => (
        <td
          key={i}
          className="min-w-[120px] px-2 py-2 align-top text-deep-green/65"
        >
          <LabeledStack
            rows={[
              { label: "matches", value: String(w.matches) },
              { label: "dpp spots", value: String(w.dppSpots) },
              {
                label: "avg price/spot",
                value:
                  w.avgPricePerSpot === null
                    ? "—"
                    : fmtUsdDec(w.avgPricePerSpot),
              },
              {
                label: "avg/match",
                value: w.matches > 0 ? fmtUsdDec(w.avgPrice) : "—",
              },
              {
                label: "rev",
                value: w.matches > 0 ? fmtUsd(w.dppRev) : "—",
              },
              {
                label: "cancels",
                value: (
                  <span
                    className={
                      w.cancels > 0 ? "text-coral" : "text-deep-green/45"
                    }
                  >
                    {w.cancels}
                  </span>
                ),
              },
            ]}
            muted
          />
        </td>
      ))}
      <td className="min-w-[160px] px-2 py-2 align-top">
        <div className="space-y-0.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-deep-green/45">matches:</span>
            <input
              type="number"
              min={0}
              step={1}
              value={matches ?? ""}
              onChange={(e) => onMatchesChange(row.venueId, e.target.value)}
              className="h-6 w-16 rounded border border-cream-line bg-white px-1.5 text-right font-mono text-[12px] tabular-nums text-deep-green focus:border-mint focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-deep-green/45">dpp spots:</span>
            <input
              type="number"
              min={0}
              step={1}
              value={dppSpots ?? ""}
              onChange={(e) => onDppSpotsChange(row.venueId, e.target.value)}
              className="h-6 w-16 rounded border border-cream-line bg-white px-1.5 text-right font-mono text-[12px] tabular-nums text-deep-green focus:border-mint focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-deep-green/45">avg price/spot:</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={
                pricePerSpotForInput == null
                  ? ""
                  : pricePerSpotForInput.toFixed(2)
              }
              onChange={(e) =>
                onAvgPricePerSpotChange(row.venueId, e.target.value)
              }
              className="h-6 w-20 rounded border border-cream-line bg-white px-1.5 text-right font-mono text-[12px] tabular-nums text-deep-green focus:border-mint focus:outline-none"
            />
          </div>
          {/* Derived display — recomputes as the operator edits any of */}
          {/* the three inputs above. Italic + muted to read as "live   */}
          {/* readout, not a knob you turn".                             */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-deep-green/45 italic">avg/match:</span>
            <span className="font-mono tabular-nums italic text-deep-green/55">
              {matches && matches > 0 ? fmtUsdDec(avgPerMatch) : "—"}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 pt-0.5">
            <span className="text-deep-green/45">rev:</span>
            <span className="font-mono text-[12px] font-bold tabular-nums text-deep-green">
              {fmtUsd(projected)}
            </span>
          </div>
          {isEdited && (
            <div className="pt-0.5 text-right">
              <button
                type="button"
                onClick={() => onReset(row.venueId)}
                className="text-[10px] text-deep-green/50 transition hover:text-deep-green hover:underline"
              >
                reset
              </button>
            </div>
          )}
        </div>
      </td>
      <td className="min-w-[130px] px-3 py-2 align-top">
        <LabeledStack
          rows={[
            {
              label: "Δ matches",
              value: <span className={matchDeltaTone}>{matchDeltaStr}</span>,
            },
            {
              label: "Δ dpp spots",
              value: <span className={spotsDeltaTone}>{spotsDeltaStr}</span>,
            },
            {
              label: "Δ rev",
              value: (
                <span className={`${revenueDeltaTone(dppDelta)} font-bold`}>
                  {fmtSig(dppDelta)}
                </span>
              ),
            },
          ]}
        />
      </td>
    </tr>
  );
}

// Vertical stack of labeled rows: muted small-caps label on the left,
// value right-aligned. Replaces the prior CellStack which only showed
// values without their role. Used in both history cells and the Δ
// column; the editable Next column inlines this pattern around its
// inputs (see FieldRow).
function LabeledStack({
  rows,
  muted = false,
}: {
  rows: { label: string; value: React.ReactNode }[];
  muted?: boolean;
}) {
  const valCls = muted ? "text-deep-green/65" : "text-deep-green";
  return (
    <div className="space-y-0.5 text-[11px]">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-baseline justify-between gap-2"
        >
          <span className="text-deep-green/45">{r.label}:</span>
          <span className={`font-mono tabular-nums ${valCls}`}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
