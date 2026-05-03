"use client";

import { useEffect, useRef, useState } from "react";
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
  type ProjectionsView,
  type SlotProjectionRow,
  type VenueProjectionGroup,
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

type SlotState = {
  matchesPlanned: number | null;
  dppSpotsPlanned: number | null;
  avgPricePerSpotPlanned: number | null;
};

const EMPTY_SLOT_STATE: SlotState = {
  matchesPlanned: null,
  dppSpotsPlanned: null,
  avgPricePerSpotPlanned: null,
};

// rowState key — stable across re-renders. Matches savedProjectionKey
// minus the week (week is implicit from view.nextWindow.start).
function slotKey(venueId: number, dow: number, slotTime: string): string {
  return `${venueId}|${dow}|${slotTime}`;
}

// Resolve effective per-spot price for the rev calc. null defaults
// (no W-1 DPP activity) collapse to 0 — the input renders empty until
// the operator types a price; the math just contributes nothing to
// totals in the meantime.
function resolvePricePerSpot(
  state: SlotState | undefined,
  slot: SlotProjectionRow,
): number {
  return state?.avgPricePerSpotPlanned ?? slot.defaults.avgPricePerSpot ?? 0;
}

function projectedRevForSlot(
  state: SlotState | undefined,
  slot: SlotProjectionRow,
): number {
  const spots = state?.dppSpotsPlanned ?? slot.defaults.dppSpots;
  const price = resolvePricePerSpot(state, slot);
  return (spots ?? 0) * price;
}

export default function WeeklyProjectionsTab() {
  const [view, setView] = useState<ProjectionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Two collapse sets: cities and venues. Venue keys are stable across
  // a load (venueId only — venue is a child of city, but we don't key
  // on city to avoid collapse state churning when a venue moves).
  const [collapsedCities, setCollapsedCities] = useState<Set<string>>(
    new Set(),
  );
  const [collapsedVenues, setCollapsedVenues] = useState<Set<number>>(
    new Set(),
  );

  // Local edit cache: keyed by `${venueId}|${dow}|${hhmm}`. Lives across
  // saves to avoid re-fetching after each upsert.
  const [rowState, setRowState] = useState<Map<string, SlotState>>(new Map());

  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
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
      // Hydrate rowState from saved values per slot.
      const next = new Map<string, SlotState>();
      for (const c of v.cities) {
        for (const ven of c.venues) {
          for (const s of ven.slots) {
            next.set(slotKey(s.venueId, s.dow, s.slotTime), {
              matchesPlanned: s.saved.matchesPlanned,
              dppSpotsPlanned: s.saved.dppSpotsPlanned,
              avgPricePerSpotPlanned: s.saved.avgPricePerSpotPlanned,
            });
          }
        }
      }
      setRowState(next);
      // Default-collapse all cities except the first — keeps the page
      // tidy on initial load. Venues default to expanded so all slots
      // are visible the moment a city is opened.
      setCollapsedCities(new Set(v.cities.slice(1).map((c) => c.city)));
      setCollapsedVenues(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      for (const t of debounceTimers.current.values()) clearTimeout(t);
      debounceTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleSave(
    venueId: number,
    dow: number,
    slotTime: string,
    weekStart: string,
  ) {
    const key = slotKey(venueId, dow, slotTime);
    const existing = debounceTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      const state = rowState.get(key);
      if (!state) return;
      try {
        await saveProjection(supabase, {
          venueId,
          weekStartDate: weekStart,
          slotDayOfWeek: dow,
          slotTime,
          matchesPlanned: state.matchesPlanned,
          dppSpotsPlanned: state.dppSpotsPlanned,
          avgPricePerSpotPlanned: state.avgPricePerSpotPlanned,
        });
      } catch (e) {
        console.error("Save projection failed:", e);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, SAVE_DEBOUNCE_MS);
    debounceTimers.current.set(key, t);
  }

  function patchSlot(
    venueId: number,
    dow: number,
    slotTime: string,
    patch: Partial<SlotState>,
  ) {
    if (!view) return;
    const key = slotKey(venueId, dow, slotTime);
    setRowState((prev) => {
      const next = new Map(prev);
      const cur = next.get(key) ?? EMPTY_SLOT_STATE;
      next.set(key, { ...cur, ...patch });
      return next;
    });
    scheduleSave(venueId, dow, slotTime, view.nextWindow.start);
  }

  function handleMatchesChange(slot: SlotProjectionRow, raw: string) {
    const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
    patchSlot(slot.venueId, slot.dow, slot.slotTime, {
      matchesPlanned: Number.isFinite(parsed as number) ? parsed : null,
    });
  }
  function handleDppSpotsChange(slot: SlotProjectionRow, raw: string) {
    const parsed = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
    patchSlot(slot.venueId, slot.dow, slot.slotTime, {
      dppSpotsPlanned: Number.isFinite(parsed as number) ? parsed : null,
    });
  }
  function handleAvgPricePerSpotChange(slot: SlotProjectionRow, raw: string) {
    const parsed = raw === "" ? null : Math.max(0, Number(raw));
    patchSlot(slot.venueId, slot.dow, slot.slotTime, {
      avgPricePerSpotPlanned: Number.isFinite(parsed as number)
        ? parsed
        : null,
    });
  }

  async function handleReset(slot: SlotProjectionRow) {
    if (!view) return;
    const key = slotKey(slot.venueId, slot.dow, slot.slotTime);
    const existing = debounceTimers.current.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.current.delete(key);
    setRowState((prev) => {
      const next = new Map(prev);
      next.set(key, EMPTY_SLOT_STATE);
      return next;
    });
    try {
      await deleteProjection(supabase, {
        venueId: slot.venueId,
        weekStartDate: view.nextWindow.start,
        slotDayOfWeek: slot.dow,
        slotTime: slot.slotTime,
      });
    } catch (e) {
      console.error("Delete projection failed:", e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleCity(city: string) {
    setCollapsedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }
  function toggleVenue(venueId: number) {
    setCollapsedVenues((prev) => {
      const next = new Set(prev);
      if (next.has(venueId)) next.delete(venueId);
      else next.add(venueId);
      return next;
    });
  }

  if (loading && !view) {
    return <p className="text-sm text-deep-green/60">Loading projections…</p>;
  }
  if (error && !view) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft p-4 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!view) return null;

  // Grand total: sum across every slot in every venue in every city.
  const grandW1 = view.cities.reduce(
    (s, c) =>
      s +
      c.venues.reduce(
        (s2, v) => s2 + v.slots.reduce((s3, sl) => s3 + sl.weeks[3].dppRev, 0),
        0,
      ),
    0,
  );
  const grandNext = view.cities.reduce(
    (s, c) =>
      s +
      c.venues.reduce(
        (s2, v) =>
          s2 +
          v.slots.reduce(
            (s3, sl) =>
              s3 +
              projectedRevForSlot(
                rowState.get(slotKey(sl.venueId, sl.dow, sl.slotTime)),
                sl,
              ),
            0,
          ),
        0,
      ),
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
          Plan next week slot-by-slot. Each row is a recurring (venue, day,
          time) — e.g., "NEMP Mon 7:30pm". Compare against the last 4 weeks
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
            cityCollapsed={collapsedCities.has(c.city)}
            collapsedVenues={collapsedVenues}
            onToggleCity={() => toggleCity(c.city)}
            onToggleVenue={toggleVenue}
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

function CityCard({
  city,
  view,
  rowState,
  cityCollapsed,
  collapsedVenues,
  onToggleCity,
  onToggleVenue,
  onMatchesChange,
  onDppSpotsChange,
  onAvgPricePerSpotChange,
  onReset,
}: {
  city: CityProjection;
  view: ProjectionsView;
  rowState: Map<string, SlotState>;
  cityCollapsed: boolean;
  collapsedVenues: Set<number>;
  onToggleCity: () => void;
  onToggleVenue: (venueId: number) => void;
  onMatchesChange: (slot: SlotProjectionRow, raw: string) => void;
  onDppSpotsChange: (slot: SlotProjectionRow, raw: string) => void;
  onAvgPricePerSpotChange: (slot: SlotProjectionRow, raw: string) => void;
  onReset: (slot: SlotProjectionRow) => void;
}) {
  const allSlots = city.venues.flatMap((v) => v.slots);
  const cityW1 = allSlots.reduce((s, sl) => s + sl.weeks[3].dppRev, 0);
  const cityNext = allSlots.reduce(
    (s, sl) =>
      s +
      projectedRevForSlot(
        rowState.get(slotKey(sl.venueId, sl.dow, sl.slotTime)),
        sl,
      ),
    0,
  );
  const cityDelta = cityNext - cityW1;
  const slotCount = allSlots.length;

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <button
        type="button"
        onClick={onToggleCity}
        aria-expanded={!cityCollapsed}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-cream-soft/40"
      >
        {cityCollapsed ? (
          <ChevronRight size={18} aria-hidden className="text-deep-green/55" />
        ) : (
          <ChevronDown size={18} aria-hidden className="text-deep-green/55" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-base font-bold text-deep-green">{city.city}</div>
          <p className="mt-0.5 text-[11px] text-deep-green/55">
            {city.venues.length}{" "}
            {city.venues.length === 1 ? "venue" : "venues"} · {slotCount}{" "}
            {slotCount === 1 ? "slot" : "slots"}
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

      {!cityCollapsed && (
        <div className="overflow-x-auto border-t border-cream-line">
          <table className="w-full text-[12px]">
            <thead className="bg-cream-soft/60 text-[10px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
              <tr>
                <th className="px-3 py-2 text-left">Slot</th>
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
              {city.venues.map((ven) => (
                <VenueGroup
                  key={ven.venueId}
                  venue={ven}
                  rowState={rowState}
                  collapsed={collapsedVenues.has(ven.venueId)}
                  onToggle={() => onToggleVenue(ven.venueId)}
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
                <td colSpan={3} className="px-2 py-2 text-right text-deep-green/55"></td>
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

function VenueGroup({
  venue,
  rowState,
  collapsed,
  onToggle,
  onMatchesChange,
  onDppSpotsChange,
  onAvgPricePerSpotChange,
  onReset,
}: {
  venue: VenueProjectionGroup;
  rowState: Map<string, SlotState>;
  collapsed: boolean;
  onToggle: () => void;
  onMatchesChange: (slot: SlotProjectionRow, raw: string) => void;
  onDppSpotsChange: (slot: SlotProjectionRow, raw: string) => void;
  onAvgPricePerSpotChange: (slot: SlotProjectionRow, raw: string) => void;
  onReset: (slot: SlotProjectionRow) => void;
}) {
  const venueW1 = venue.slots.reduce((s, sl) => s + sl.weeks[3].dppRev, 0);
  const venueNext = venue.slots.reduce(
    (s, sl) =>
      s +
      projectedRevForSlot(
        rowState.get(slotKey(sl.venueId, sl.dow, sl.slotTime)),
        sl,
      ),
    0,
  );
  const venueDelta = venueNext - venueW1;
  const slotCount = venue.slots.length;

  return (
    <>
      {/* Venue header — clickable, summarizes the slot rows beneath. */}
      <tr className="border-t border-cream-line bg-cream-soft/30">
        <td colSpan={7} className="px-3 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-2 text-left"
          >
            {collapsed ? (
              <ChevronRight
                size={14}
                aria-hidden
                className="text-deep-green/55"
              />
            ) : (
              <ChevronDown
                size={14}
                aria-hidden
                className="text-deep-green/55"
              />
            )}
            <span className="font-bold text-deep-green">{venue.venueName}</span>
            <span className="text-[10px] text-deep-green/55">
              ({slotCount} {slotCount === 1 ? "slot" : "slots"})
            </span>
            <span className="ml-auto flex items-baseline gap-2 font-mono text-[12px] tabular-nums">
              <span className="text-deep-green/55">{fmtUsd(venueW1)}</span>
              <span aria-hidden className="text-deep-green/35">→</span>
              <span className="text-deep-green">{fmtUsd(venueNext)}</span>
              <span
                className={`font-bold ${revenueDeltaTone(venueDelta)}`}
              >
                {fmtSig(venueDelta)}
              </span>
            </span>
          </button>
        </td>
      </tr>
      {!collapsed &&
        venue.slots.map((sl) => (
          <SlotRow
            key={`${sl.venueId}-${sl.dow}-${sl.slotTime}`}
            slot={sl}
            state={rowState.get(slotKey(sl.venueId, sl.dow, sl.slotTime))}
            onMatchesChange={onMatchesChange}
            onDppSpotsChange={onDppSpotsChange}
            onAvgPricePerSpotChange={onAvgPricePerSpotChange}
            onReset={onReset}
          />
        ))}
    </>
  );
}

function SlotRow({
  slot,
  state,
  onMatchesChange,
  onDppSpotsChange,
  onAvgPricePerSpotChange,
  onReset,
}: {
  slot: SlotProjectionRow;
  state: SlotState | undefined;
  onMatchesChange: (slot: SlotProjectionRow, raw: string) => void;
  onDppSpotsChange: (slot: SlotProjectionRow, raw: string) => void;
  onAvgPricePerSpotChange: (slot: SlotProjectionRow, raw: string) => void;
  onReset: (slot: SlotProjectionRow) => void;
}) {
  const matches = state?.matchesPlanned ?? slot.defaults.matches;
  const dppSpots = state?.dppSpotsPlanned ?? slot.defaults.dppSpots;
  const pricePerSpotForInput =
    state?.avgPricePerSpotPlanned ?? slot.defaults.avgPricePerSpot;
  const pricePerSpotForCalc = pricePerSpotForInput ?? 0;
  const projected = (dppSpots ?? 0) * pricePerSpotForCalc;
  const avgPerMatch = matches && matches > 0 ? projected / matches : 0;

  const isEdited =
    state?.matchesPlanned != null ||
    state?.dppSpotsPlanned != null ||
    state?.avgPricePerSpotPlanned != null;

  const w1 = slot.weeks[3];
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
    matchDelta > 0 ? `+${matchDelta}` : matchDelta === 0 ? "0" : `${matchDelta}`;
  const spotsDeltaTone =
    spotsDelta === 0
      ? "text-deep-green/45"
      : spotsDelta > 0
        ? "text-mint-hover"
        : "text-coral";
  const spotsDeltaStr =
    spotsDelta > 0 ? `+${spotsDelta}` : spotsDelta === 0 ? "0" : `${spotsDelta}`;

  // Thin-data badge: (N/4) when fewer than 4 weeks have data. Muted
  // styling — informational, not alarming.
  const showThinBadge = slot.weeksWithData < 4;

  return (
    <tr className="border-t border-cream-line/60">
      <td className="px-3 py-2 pl-8 align-top">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-deep-green">{slot.slotLabel}</span>
          {showThinBadge && (
            <span className="text-[10px] text-deep-green/45 italic">
              ({slot.weeksWithData}/4)
            </span>
          )}
        </div>
      </td>
      {slot.weeks.map((w, i) => {
        const noData = w.matches === 0 && w.cancels === 0;
        return (
          <td
            key={i}
            className="min-w-[120px] px-2 py-2 align-top text-deep-green/65"
          >
            {noData ? (
              <span className="text-deep-green/35">—</span>
            ) : (
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
                          w.cancels > 0
                            ? "text-coral"
                            : "text-deep-green/45"
                        }
                      >
                        {w.cancels}
                      </span>
                    ),
                  },
                ]}
                muted
              />
            )}
          </td>
        );
      })}
      <td className="min-w-[160px] px-2 py-2 align-top">
        <div className="space-y-0.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-deep-green/45">matches:</span>
            <input
              type="number"
              min={0}
              step={1}
              value={matches ?? ""}
              onChange={(e) => onMatchesChange(slot, e.target.value)}
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
              onChange={(e) => onDppSpotsChange(slot, e.target.value)}
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
              onChange={(e) => onAvgPricePerSpotChange(slot, e.target.value)}
              className="h-6 w-20 rounded border border-cream-line bg-white px-1.5 text-right font-mono text-[12px] tabular-nums text-deep-green focus:border-mint focus:outline-none"
            />
          </div>
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
                onClick={() => onReset(slot)}
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
