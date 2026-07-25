"use client";

// Field Ops → Inventory dashboard. Reads inventory_submissions (auth
// SELECT RLS), dedups to the latest report per manager, and renders the
// approved mock's layout: a summary strip, per-city sections in canonical
// order, and manager cards with the ported coverage math. All the logic
// (calcCoverage, dedupeLatest, isStale, isRequested, relativeTime,
// summarize) is the exact port in lib/inventory.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Link2, Check } from "lucide-react";
import { supabase } from "@/lib/supabase";
import CityChip from "@/components/CityChip";
import { CITIES } from "@/lib/types";
import { normalizeCityName } from "@/lib/cityNormalization";
import {
  calcCoverage,
  dedupeLatest,
  isStale,
  isRequested,
  relativeTime,
  initials,
  summarize,
  bibTotals,
  type InventoryRow,
  type BibColorKey,
} from "@/lib/inventory";

const SELECT_COLS =
  "id, submitted_at, name, city, white, green, orange, blue, black, red, balls, needs";

// Literal bib colors (six). Counts are SETS.
const BIB: Record<BibColorKey, { label: string; style: React.CSSProperties }> = {
  white: { label: "White", style: { background: "#e7e4d8", boxShadow: "inset 0 0 0 1px #b9b6a8" } },
  green: { label: "Green", style: { background: "#4d9e22" } },
  orange: { label: "Orange", style: { background: "#ef9f27" } },
  blue: { label: "Blue", style: { background: "#378add" } },
  black: { label: "Black", style: { background: "#1a1a1a" } },
  red: { label: "Red", style: { background: "#c8332a" } },
};
const COLOR_KEYS: BibColorKey[] = ["white", "green", "orange", "blue", "black", "red"];

function Dot({ color, size = 11 }: { color: BibColorKey; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, ...BIB[color].style }}
    />
  );
}

export default function InventoryDashboard() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cityFilter, setCityFilter] = useState("all");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase
        .from("inventory_submissions")
        .select(SELECT_COLS)
        .order("submitted_at", { ascending: false });
      if (e) throw e;
      setRows((data ?? []) as InventoryRow[]);
      setSyncedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't load inventory. (Has migration 0077 been applied?)",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();

  // Latest per manager, then apply the city filter.
  const latest = useMemo(() => dedupeLatest(rows), [rows]);
  const filtered = useMemo(
    () => (cityFilter === "all" ? latest : latest.filter((r) => r.city === cityFilter)),
    [latest, cityFilter],
  );
  const summary = useMemo(() => summarize(filtered, nowMs), [filtered, nowMs]);

  // Group by city in canonical order; newest card first within a city.
  const groups = useMemo(() => {
    const byCity = new Map<string, InventoryRow[]>();
    for (const r of filtered) {
      const arr = byCity.get(r.city);
      if (arr) arr.push(r);
      else byCity.set(r.city, [r]);
    }
    return CITIES.filter((c) => byCity.has(c)).map((city) => {
      const cards = byCity
        .get(city)!
        .slice()
        .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
      // Same coercing, all-6-colors totals helper as the summary strip —
      // no separate reducer to miss black/red or NaN.
      const totals = bibTotals(cards);
      return { city, code: normalizeCityName(city) ?? city, cards, totals };
    });
  }, [filtered]);

  const copyLink = useCallback(() => {
    const url = `${window.location.origin}/inventory`;
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, []);

  const citiesInData = useMemo(
    () => CITIES.filter((c) => latest.some((r) => r.city === c)),
    [latest],
  );

  return (
    <section>
      {/* Controls bar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="text-[17px] font-extrabold text-deep-green">
          Equipment Inventory
          <span className="ml-2 text-[12.5px] font-semibold text-deep-green/45">
            latest report per manager
          </span>
        </div>
        <div className="flex-1" />
        {syncedAt && (
          <span className="text-[11px] font-semibold text-deep-green/35">
            Synced {syncedAt}
          </span>
        )}
        <select
          value={cityFilter}
          onChange={(e) => setCityFilter(e.target.value)}
          className="rounded-xl border border-cream-line bg-white px-3 py-2 text-sm font-semibold text-deep-green focus:border-mint focus:outline-none"
        >
          <option value="all">All cities</option>
          {citiesInData.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-xl border border-cream-line bg-white px-3 py-2 text-[13px] font-bold text-deep-green transition hover:bg-cream-soft"
        >
          <RefreshCw aria-hidden size={14} /> Refresh
        </button>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-1.5 rounded-xl bg-mint px-4 py-2 text-[13px] font-extrabold text-deep-green transition hover:bg-mint-hover"
        >
          {copied ? <Check aria-hidden size={14} /> : <Link2 aria-hidden size={14} />}
          {copied ? "Copied!" : "Copy form link"}
        </button>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-cream-line bg-white py-16 text-center text-sm text-deep-green/50">
          Loading inventory…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-coral/30 bg-coral-soft/40 px-4 py-3 text-sm text-coral-hover">
          {error}
        </div>
      ) : latest.length === 0 ? (
        <div className="rounded-2xl border border-cream-line bg-white py-16 text-center text-sm text-deep-green/50">
          No inventory submissions yet. When managers fill the form, they’ll
          appear here.
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <SummaryCard label="Managers reporting" value={summary.managers} />
            <SummaryCard label="Total balls" value={summary.totalBalls} />
            <div className="rounded-2xl border border-cream-line bg-white px-4 py-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10.5px] font-extrabold uppercase tracking-wide text-deep-green/45">
                Bib sets
                {COLOR_KEYS.map((k) => (
                  <Dot key={k} color={k} size={8} />
                ))}
              </div>
              <div className="text-[15px] font-extrabold tabular-nums text-deep-green">
                {COLOR_KEYS.map((k) => summary.bib[k]).join(" · ")}
              </div>
            </div>
            <SummaryCard
              label="Requested items"
              value={summary.requested}
              tone={summary.requested > 0 ? "warn" : undefined}
            />
            <SummaryCard
              label="Stale reports"
              value={summary.stale}
              tone={summary.stale > 0 ? "bad" : undefined}
            />
          </div>

          {/* City sections */}
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.city}>
                <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-cream-line pb-2.5">
                  <span className="inline-flex items-center gap-2">
                    <CityChip code={g.code} size="sm" />
                    <span className="text-sm font-extrabold uppercase tracking-wide text-deep-green">
                      {g.city}
                    </span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-deep-green/50">
                    <span>
                      {g.cards.length} manager{g.cards.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-deep-green/25">·</span>
                    {COLOR_KEYS.map((c) => (
                      <span key={c} className="inline-flex items-center gap-1">
                        <Dot color={c} size={9} />
                        <b className="font-extrabold tabular-nums text-deep-green">
                          {g.totals[c]}
                        </b>
                      </span>
                    ))}
                    <span className="text-deep-green/25">·</span>
                    <span>
                      <b className="font-extrabold tabular-nums text-deep-green">
                        {g.totals.balls}
                      </b>{" "}
                      balls
                    </span>
                  </div>
                </div>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
                  {g.cards.map((r) => (
                    <ManagerCard key={r.id} row={r} nowMs={nowMs} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "bad";
}) {
  const color =
    tone === "bad" ? "text-coral" : tone === "warn" ? "text-amber-600" : "text-deep-green";
  return (
    <div className="rounded-2xl border border-cream-line bg-white px-4 py-3">
      <div className="mb-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-deep-green/45">
        {label}
      </div>
      <div className={`text-2xl font-extrabold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function ManagerCard({ row, nowMs }: { row: InventoryRow; nowMs: number }) {
  const stale = isStale(row.submitted_at, nowMs);
  const requested = isRequested(row.needs);
  const cov = calcCoverage(row);
  const dateStr = new Date(row.submitted_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div
      className={`relative rounded-2xl border bg-white px-4 py-4 ${
        stale ? "border-red-300" : "border-cream-line"
      }`}
    >
      {stale && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px] rounded-t-2xl bg-coral"
        />
      )}
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mint-soft text-[13px] font-extrabold text-deep-green">
          {initials(row.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-extrabold text-deep-green">
            {row.name}
          </div>
          <div className="text-[11.5px] tabular-nums text-deep-green/45">
            Updated {relativeTime(row.submitted_at, nowMs)} · {dateStr}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-extrabold ${
            stale ? "bg-red-50 text-red-600" : "bg-mint-soft text-mint-hover"
          }`}
        >
          {stale ? "Stale" : "Current"}
        </span>
      </div>

      <div className="mb-2.5 flex items-center gap-2 rounded-lg bg-cream-soft/70 px-3 py-2">
        <span className="flex-1 text-[12.5px] font-semibold text-deep-green/70">
          ⚽ MatchDay balls
        </span>
        <span className="text-[15px] font-extrabold tabular-nums text-deep-green">
          {row.balls}
        </span>
      </div>

      <div className="mb-2.5 rounded-lg border border-cream-line px-3 py-2.5">
        <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-wide text-deep-green/35">
          Bib sets on hand
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          {COLOR_KEYS.map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <Dot color={c} />
              <span className="flex-1 text-[12.5px] text-deep-green/60">
                {BIB[c].label}
              </span>
              <span className="text-[13.5px] font-extrabold tabular-nums text-deep-green">
                {row[c]}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-cream-soft/70 px-3 py-2.5">
        <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-wide text-deep-green/40">
          Max concurrent games possible
        </div>
        {cov.pairings.length === 0 ? (
          <div className="text-[13px] text-coral">No complete pairings available</div>
        ) : (
          cov.pairings.map((p, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5 text-[13px] text-deep-green/80">
              <Dot color={p.a} size={8} />
              <span>{BIB[p.a].label}</span>
              <span className="text-[11px] text-deep-green/35">vs</span>
              <Dot color={p.b} size={8} />
              <span>{BIB[p.b].label}</span>
              <span className="ml-1.5 font-extrabold tabular-nums">
                {p.games} game{p.games === 1 ? "" : "s"}
              </span>
            </div>
          ))
        )}
        {cov.pairings.length > 0 && (
          <div className="mt-1.5 border-t border-cream-line pt-1.5 text-[12.5px] font-extrabold text-deep-green">
            Total: {cov.total} game{cov.total === 1 ? "" : "s"} at once
          </div>
        )}
        {cov.leftovers.length > 0 && (
          <div className="mt-1 text-[11px] text-deep-green/35">
            Leftover:{" "}
            {cov.leftovers.map((l) => `${l.count} ${BIB[l.color].label}`).join(", ")}
          </div>
        )}
      </div>

      {requested && row.needs && (
        <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
          <span className="mb-0.5 block text-[9.5px] font-extrabold uppercase tracking-wide text-amber-700">
            Requested
          </span>
          {row.needs}
        </div>
      )}
    </div>
  );
}

