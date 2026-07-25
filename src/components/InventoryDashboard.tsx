"use client";

// Field Ops → Inventory dashboard. Reads inventory_submissions (auth
// SELECT RLS), dedups to the latest report per manager, and renders the
// approved mock's layout: a summary strip, per-city sections in canonical
// order, and manager cards with the ported coverage math. All the logic
// (calcCoverage, dedupeLatest, isStale, isRequested, relativeTime,
// summarize) is the exact port in lib/inventory.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Link2, Check, Pencil, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
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
  validateInventorySubmission,
  INVENTORY_CITIES,
  type InventoryRow,
  type BibColorKey,
} from "@/lib/inventory";

// Session bearer for the admin-gated edit/delete routes.
async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

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

  // --- admin edit / delete ---
  const { appUser } = useAuth();
  const isAdmin = appUser?.is_admin === true;
  const [editRow, setEditRow] = useState<InventoryRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<InventoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);

  const saveEdit = useCallback(
    async (id: string, payload: Record<string, unknown>) => {
      setBusy(true);
      setMutError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session.");
        const res = await fetch(`/api/inventory/${id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        setEditRow(null);
        await load();
      } catch (e) {
        setMutError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const deleteReport = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session.");
        const res = await fetch(`/api/inventory/${id}`, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDeleteRow(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const deleteManager = useCallback(
    async (name: string, city: string) => {
      setBusy(true);
      try {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session.");
        const res = await fetch("/api/inventory/delete-manager", {
          method: "POST",
          headers,
          body: JSON.stringify({ name, city }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDeleteRow(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
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
                    <ManagerCard
                      key={r.id}
                      row={r}
                      nowMs={nowMs}
                      isAdmin={isAdmin}
                      onEdit={() => {
                        setMutError(null);
                        setEditRow(r);
                      }}
                      onDelete={() => setDeleteRow(r)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {editRow && (
        <EditModal
          row={editRow}
          saving={busy}
          error={mutError}
          onClose={() => setEditRow(null)}
          onSave={(payload) => saveEdit(editRow.id, payload)}
        />
      )}
      {deleteRow && (
        <DeleteDialog
          row={deleteRow}
          busy={busy}
          onCancel={() => setDeleteRow(null)}
          onDeleteReport={() => deleteReport(deleteRow.id)}
          onDeleteManager={() => deleteManager(deleteRow.name, deleteRow.city)}
        />
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

function ManagerCard({
  row,
  nowMs,
  isAdmin,
  onEdit,
  onDelete,
}: {
  row: InventoryRow;
  nowMs: number;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
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
      className={`group relative rounded-2xl border bg-white px-4 py-4 ${
        stale ? "border-red-300" : "border-cream-line"
      }`}
    >
      {stale && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px] rounded-t-2xl bg-coral"
        />
      )}
      {isAdmin && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${row.name}`}
            title="Edit report"
            className="rounded-lg border border-cream-line bg-white p-1.5 text-deep-green/50 transition hover:border-mint hover:text-deep-green"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${row.name}`}
            title="Delete report"
            className="rounded-lg border border-cream-line bg-white p-1.5 text-deep-green/50 transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
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

// ---- Admin: edit a submission ----------------------------------------
function EditModal({
  row,
  saving,
  error,
  onClose,
  onSave,
}: {
  row: InventoryRow;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(row.name);
  const [city, setCity] = useState(row.city);
  const [counts, setCounts] = useState<Record<BibColorKey, string>>({
    white: String(row.white),
    green: String(row.green),
    orange: String(row.orange),
    blue: String(row.blue),
    black: String(row.black),
    red: String(row.red),
  });
  const [balls, setBalls] = useState(String(row.balls));
  const [needs, setNeeds] = useState(row.needs ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const payload = {
      name,
      city,
      white: counts.white,
      green: counts.green,
      orange: counts.orange,
      blue: counts.blue,
      black: counts.black,
      red: counts.red,
      balls,
      needs,
    };
    // Same validation as the public form, for instant feedback.
    const result = validateInventorySubmission(payload);
    if (!result.ok) {
      setLocalError(result.error);
      return;
    }
    setLocalError(null);
    onSave(result.value as unknown as Record<string, unknown>);
  };

  const countInput = (key: BibColorKey) => (
    <label key={key} className="flex items-center gap-1.5">
      <Dot color={key} />
      <span className="flex-1 text-[12.5px] text-deep-green/70">{BIB[key].label}</span>
      <input
        type="number"
        min={0}
        max={999}
        inputMode="numeric"
        value={counts[key]}
        onChange={(e) => setCounts((c) => ({ ...c, [key]: e.target.value }))}
        className="w-16 rounded-md border border-cream-line bg-white px-2 py-1 text-right text-[13.5px] font-extrabold tabular-nums text-deep-green focus:border-mint focus:outline-none"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-cream-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-cream-line px-5 py-4">
          <h2 className="text-[16px] font-extrabold text-deep-green">Edit report</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-deep-green/40 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-deep-green/40">
                Manager name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green focus:border-mint focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-deep-green/40">
                City
              </span>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green focus:border-mint focus:outline-none"
              >
                {!INVENTORY_CITIES.includes(city as (typeof INVENTORY_CITIES)[number]) && (
                  <option value={city}>{city} (current)</option>
                )}
                {INVENTORY_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4 rounded-lg border border-cream-line px-3 py-3">
            <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-wide text-deep-green/35">
              Bib sets on hand
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {COLOR_KEYS.map(countInput)}
            </div>
          </div>

          <label className="mt-4 flex items-center gap-2 rounded-lg bg-cream-soft/70 px-3 py-2">
            <span className="flex-1 text-[12.5px] font-semibold text-deep-green/70">
              ⚽ MatchDay balls
            </span>
            <input
              type="number"
              min={0}
              max={999}
              inputMode="numeric"
              value={balls}
              onChange={(e) => setBalls(e.target.value)}
              className="w-16 rounded-md border border-cream-line bg-white px-2 py-1 text-right text-[14px] font-extrabold tabular-nums text-deep-green focus:border-mint focus:outline-none"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1 block text-[11px] font-extrabold uppercase tracking-wide text-deep-green/40">
              Requests / needs
            </span>
            <textarea
              value={needs}
              onChange={(e) => setNeeds(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-deep-green focus:border-mint focus:outline-none"
            />
          </label>

          {(localError || error) && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
              {localError || error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-cream-line px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-cream-line bg-white px-4 py-2 text-[13.5px] font-bold text-deep-green/70 transition hover:bg-cream-soft disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded-lg bg-deep-green px-4 py-2 text-[13.5px] font-bold text-cream transition hover:bg-deep-green/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Admin: delete confirm (two options) -----------------------------
function DeleteDialog({
  row,
  busy,
  onCancel,
  onDeleteReport,
  onDeleteManager,
}: {
  row: InventoryRow;
  busy: boolean;
  onCancel: () => void;
  onDeleteReport: () => void;
  onDeleteManager: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-cream-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-cream-line px-5 py-4">
          <h2 className="text-[16px] font-extrabold text-deep-green">Delete report</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-lg p-1 text-deep-green/40 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-[13.5px] leading-relaxed text-deep-green/70">
            <span className="font-extrabold text-deep-green">{row.name}</span> ·{" "}
            {row.city}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-deep-green/60">
            Delete just this report, or every report ever submitted by this manager?
            This can’t be undone.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={onDeleteReport}
              disabled={busy}
              className="rounded-lg border border-cream-line bg-white px-4 py-2.5 text-left text-[13.5px] font-bold text-deep-green transition hover:border-coral/50 hover:bg-coral-soft disabled:opacity-50"
            >
              Delete this report
              <span className="mt-0.5 block text-[11.5px] font-medium text-deep-green/45">
                Falls back to this manager’s prior report, if any.
              </span>
            </button>
            <button
              type="button"
              onClick={onDeleteManager}
              disabled={busy}
              className="rounded-lg border border-coral/40 bg-coral-soft px-4 py-2.5 text-left text-[13.5px] font-bold text-coral-hover transition hover:bg-coral hover:text-white disabled:opacity-50"
            >
              Delete all reports from this manager
              <span className="mt-0.5 block text-[11.5px] font-medium text-coral-hover/70">
                Removes every submission for {row.name} · {row.city}.
              </span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-cream-line px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-cream-line bg-white px-4 py-2 text-[13.5px] font-bold text-deep-green/70 transition hover:bg-cream-soft disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

