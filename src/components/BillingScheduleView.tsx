"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Layers, List, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import BillingScheduleCalendar from "@/components/BillingScheduleCalendar";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import ScheduleBulkAddEditor, {
  type BulkScheduleDraft,
} from "@/components/ScheduleBulkAddEditor";
import ScheduleRowEditor, {
  type ScheduleDraft,
} from "@/components/ScheduleRowEditor";
import { logChange } from "@/lib/financeAudit";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  getCurrentMonthInQuarter,
  type Q2Month,
} from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import {
  refetchFinanceData,
  useFinanceData,
  type FinSchedule,
} from "@/lib/useFinanceData";

type SortKey =
  | "date"
  | "city"
  | "venue"
  | "match_count"
  | "total_hours"
  | "venue_cost";
type SortDir = "asc" | "desc";

type MonthFilter = Q2Month | "ALL" | "RANGE";
type SourceFilter = "ALL" | "SHEET" | "MANUAL";

const ALL = "All";

function fmt(n: number | null | undefined, signZero = false): string {
  if (n == null) return "—";
  const r = Math.round(n);
  if (r === 0 && !signZero) return "—";
  return r.toLocaleString("en-US");
}

function fmtMoney(n: number | null | undefined, signZero = false): string {
  if (n == null) return "—";
  const r = Math.round(n);
  if (r === 0 && !signZero) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

function monthFromDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-/);
  if (!m) return "";
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx > 11) return "";
  return `${monthNames[idx]} ${m[1]}`;
}

export default function BillingScheduleView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();

  const [monthFilter, setMonthFilter] = useState<MonthFilter>(
    () =>
      getCurrentMonthInQuarter(quarter, new Date()) ??
      quarter.months[quarter.months.length - 1].key,
  );
  // Re-clamp when the quarter changes so a stale Q2 month key
  // doesn't carry into a Q3 view.
  useEffect(() => {
    if (monthFilter === "ALL" || monthFilter === "RANGE") return;
    if (!quarter.months.some((m) => m.key === monthFilter)) {
      setMonthFilter(
        getCurrentMonthInQuarter(quarter, new Date()) ??
          quarter.months[quarter.months.length - 1].key,
      );
    }
  }, [quarter, monthFilter]);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [cityFilter, setCityFilter] = useState<string>(ALL);
  const [venueFilter, setVenueFilter] = useState<string>(ALL);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("ALL");

  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");
  const [editorRow, setEditorRow] = useState<FinSchedule | null>(null);
  const [editorPrefill, setEditorPrefill] = useState<{
    date?: string;
    venueId?: number;
  } | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteRow, setDeleteRow] = useState<FinSchedule | null>(null);

  type ViewMode = "calendar" | "list";
  const [view, setView] = useState<ViewMode>("calendar");
  const [hideEmptyVenues, setHideEmptyVenues] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("billing-schedule-view");
      if (saved === "list" || saved === "calendar") setView(saved);
    } catch {
      // localStorage unavailable; keep default
    }
  }, []);

  function setViewPersisted(v: ViewMode) {
    setView(v);
    try {
      window.localStorage.setItem("billing-schedule-view", v);
    } catch {
      // ignore
    }
  }

  const allRows = data?.schedule ?? [];

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.city) set.add(r.city);
    return [ALL, ...[...set].sort()];
  }, [allRows]);

  const venueOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.venue) set.add(r.venue);
    return [ALL, ...[...set].sort()];
  }, [allRows]);

  const filtered = useMemo(() => {
    let rows = allRows.slice();
    if (monthFilter === "RANGE") {
      if (rangeFrom) rows = rows.filter((r) => r.date && r.date >= rangeFrom);
      if (rangeTo) rows = rows.filter((r) => r.date && r.date <= rangeTo);
    } else if (monthFilter !== "ALL") {
      rows = rows.filter((r) => r.month === monthFilter);
    }
    if (cityFilter !== ALL) rows = rows.filter((r) => r.city === cityFilter);
    if (venueFilter !== ALL) rows = rows.filter((r) => r.venue === venueFilter);
    if (sourceFilter === "SHEET") rows = rows.filter((r) => !r.manual_entry);
    if (sourceFilter === "MANUAL") rows = rows.filter((r) => r.manual_entry);
    return rows;
  }, [allRows, monthFilter, rangeFrom, rangeTo, cityFilter, venueFilter, sourceFilter]);

  const sorted = useMemo(() => {
    const rows = filtered.slice();
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "desc" ? bv - av : av - bv;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "desc" ? bs.localeCompare(as) : as.localeCompare(bs);
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const totalMatches = useMemo(
    () => filtered.reduce((s, r) => s + (r.match_count ?? 0), 0),
    [filtered],
  );
  const totalCost = useMemo(
    () => filtered.reduce((s, r) => s + (r.venue_cost ?? 0), 0),
    [filtered],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function openAdd(prefill?: { date?: string; venueId?: number }) {
    setEditorMode("add");
    setEditorRow(null);
    setEditorPrefill(prefill ?? null);
    setEditorOpen(true);
  }

  function openEdit(row: FinSchedule) {
    setEditorMode("edit");
    setEditorRow(row);
    setEditorPrefill(null);
    setEditorOpen(true);
  }

  async function handleSubmit(draft: ScheduleDraft): Promise<void> {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");

    if (editorMode === "add") {
      const payload = {
        date: draft.date,
        month: draft.month,
        city: draft.city,
        venue: draft.venue_name,
        match_count: draft.match_count,
        total_hours: draft.total_hours,
        venue_cost: draft.venue_cost,
        notes: draft.notes || null,
        manual_entry: true,
        created_by: email,
      };
      const { data: inserted, error } = await supabase
        .from("fin_schedule")
        .insert(payload)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_schedule",
        rowId: (inserted as { id: number }).id,
        action: "insert",
        changedBy: email,
        after: inserted as Record<string, unknown>,
      });
    } else if (editorMode === "edit" && editorRow) {
      const before = { ...editorRow };
      const updates = {
        date: draft.date,
        month: draft.month,
        city: draft.city,
        venue: draft.venue_name,
        match_count: draft.match_count,
        total_hours: draft.total_hours,
        venue_cost: draft.venue_cost,
        notes: draft.notes || null,
        manual_entry: true,
      };
      const { data: updated, error } = await supabase
        .from("fin_schedule")
        .update(updates)
        .eq("id", editorRow.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      const wasImport = !before.manual_entry;
      await logChange({
        tableName: "fin_schedule",
        rowId: editorRow.id,
        action: "update",
        changedBy: email,
        before: before as unknown as Record<string, unknown>,
        after: updated as Record<string, unknown>,
        note: wasImport
          ? "Converted from Sheet-imported to manual entry"
          : null,
      });
    }

    await refetchFinanceData();
    setEditorOpen(false);
  }

  async function handleBulkSubmit(draft: BulkScheduleDraft): Promise<void> {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");

    const totalMatches = draft.dates.length * draft.match_count;
    const note = `Bulk add: ${draft.dates.length} date${draft.dates.length === 1 ? "" : "s"} × ${draft.match_count} = ${totalMatches} match${totalMatches === 1 ? "" : "es"} at ${draft.venue_name} for ${draft.month}`;
    const payloads = draft.dates.map((date) => ({
      date,
      month: draft.month,
      city: draft.city,
      venue: draft.venue_name,
      match_count: draft.match_count,
      total_hours: draft.total_hours,
      venue_cost: null,
      notes: null,
      manual_entry: true,
      created_by: email,
    }));

    const { data: inserted, error } = await supabase
      .from("fin_schedule")
      .insert(payloads)
      .select();
    if (error) throw new Error(error.message);

    for (const row of (inserted ?? []) as Array<{ id: number } & Record<string, unknown>>) {
      await logChange({
        tableName: "fin_schedule",
        rowId: row.id,
        action: "insert",
        changedBy: email,
        after: row as unknown as Record<string, unknown>,
        note,
      });
    }

    await refetchFinanceData();
    setBulkOpen(false);
  }

  async function handleDelete(): Promise<void> {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");
    if (!deleteRow) return;

    const wasImport = !deleteRow.manual_entry;
    await logChange({
      tableName: "fin_schedule",
      rowId: deleteRow.id,
      action: "delete",
      changedBy: email,
      before: deleteRow as unknown as Record<string, unknown>,
      note: wasImport
        ? "Deleted Sheet-imported row — will reappear on next Sheet import unless removed at source"
        : null,
    });
    const { error } = await supabase
      .from("fin_schedule")
      .delete()
      .eq("id", deleteRow.id);
    if (error) throw new Error(error.message);

    await refetchFinanceData();
    setDeleteRow(null);
  }

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Billing Schedule
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Manage what each venue bills MatchDay for. Decoupled from player
            registrations — a canceled match may still incur charges.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="View mode"
            className="inline-flex rounded-full border border-cream-line bg-white p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "calendar"}
              onClick={() => setViewPersisted("calendar")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition ${
                view === "calendar"
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/60 hover:text-deep-green"
              }`}
            >
              <CalendarDays size={12} aria-hidden />
              Calendar
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "list"}
              onClick={() => setViewPersisted("list")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition ${
                view === "list"
                  ? "bg-mint text-deep-green"
                  : "text-deep-green/60 hover:text-deep-green"
              }`}
            >
              <List size={12} aria-hidden />
              List
            </button>
          </div>
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-cream-line bg-white px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft"
          >
            <Layers size={14} aria-hidden />
            Bulk Add
          </button>
          <button
            type="button"
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green hover:bg-mint-hover"
          >
            <Plus size={16} aria-hidden />
            Add Match
          </button>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Month">
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value as MonthFilter)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All months</option>
            {quarter.months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.key}
              </option>
            ))}
            <option value="RANGE">Custom range</option>
          </select>
        </Filter>
        {monthFilter === "RANGE" && (
          <>
            <Filter label="From">
              <input
                type="date"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Filter>
            <Filter label="To">
              <input
                type="date"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Filter>
          </>
        )}
        <Filter label="City">
          <select
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {cityOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="Venue">
          <select
            value={venueFilter}
            onChange={(e) => setVenueFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {venueOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="Source">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All</option>
            <option value="SHEET">Sheet import</option>
            <option value="MANUAL">Manual</option>
          </select>
        </Filter>
        {view === "calendar" && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-deep-green/75">
            <input
              type="checkbox"
              checked={hideEmptyVenues}
              onChange={(e) => setHideEmptyVenues(e.target.checked)}
            />
            Hide empty venues
          </label>
        )}
      </div>

      {view === "calendar" && (
        <BillingScheduleCalendar
          rows={filtered}
          venues={data?.venues ?? []}
          overrides={data?.overrides ?? []}
          monthFilter={monthFilter}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          cityFilter={cityFilter}
          venueFilter={venueFilter}
          hideEmptyVenues={hideEmptyVenues}
          onEditRow={openEdit}
          onAddCell={(venue, date) =>
            openAdd({ date, venueId: venue.id })
          }
        />
      )}

      {view === "list" && (
      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr className="border-b border-cream-line">
                <Th
                  label="Date"
                  active={sortKey === "date"}
                  dir={sortDir}
                  onClick={() => toggleSort("date")}
                />
                <Th
                  label="City"
                  active={sortKey === "city"}
                  dir={sortDir}
                  onClick={() => toggleSort("city")}
                />
                <Th
                  label="Venue"
                  active={sortKey === "venue"}
                  dir={sortDir}
                  onClick={() => toggleSort("venue")}
                />
                <Th
                  label="Matches"
                  align="right"
                  active={sortKey === "match_count"}
                  dir={sortDir}
                  onClick={() => toggleSort("match_count")}
                />
                <Th
                  label="Hours"
                  align="right"
                  active={sortKey === "total_hours"}
                  dir={sortDir}
                  onClick={() => toggleSort("total_hours")}
                />
                <Th
                  label="Venue Cost"
                  align="right"
                  active={sortKey === "venue_cost"}
                  dir={sortDir}
                  onClick={() => toggleSort("venue_cost")}
                />
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {loading && sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading billing schedule…
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    No schedule rows match these filters.
                  </td>
                </tr>
              ) : (
                sorted.map((row) => (
                  <tr
                    key={row.id}
                    className="group border-t border-cream-line/40 hover:bg-cream-soft/50"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-deep-green">
                      {row.date}
                    </td>
                    <td className="px-3 py-2 text-deep-green">{row.city}</td>
                    <td className="px-3 py-2 text-deep-green/85">
                      {row.venue}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                      {row.match_count}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/65">
                      {fmt(row.total_hours)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/65">
                      {fmtMoney(row.venue_cost)}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-deep-green/65">
                      {row.notes ?? ""}
                    </td>
                    <td className="px-3 py-2">
                      {row.manual_entry ? (
                        <span className="inline-flex items-center rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-inset ring-mint/40">
                          Manual
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/45"
                          title="Imported from Sheet — re-upload to modify, or use Edit to convert to a manual entry"
                        >
                          <Lock size={10} aria-hidden />
                          Sheet
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          className="rounded-full p-1 text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
                          aria-label="Edit row"
                          title={
                            row.manual_entry
                              ? "Edit"
                              : "Edit (will convert to manual)"
                          }
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteRow(row)}
                          className="rounded-full p-1 text-coral/70 hover:bg-coral-soft/50 hover:text-coral"
                          aria-label="Delete row"
                          title="Delete"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-cream-line/60 bg-cream-soft/40 px-4 py-3 text-xs text-deep-green/70">
          <div>
            Showing{" "}
            <span className="font-mono font-bold tabular-nums text-deep-green">
              {filtered.length.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="font-mono tabular-nums">
              {allRows.length.toLocaleString()}
            </span>{" "}
            rows
          </div>
          <div className="flex flex-wrap items-baseline gap-4">
            <div>
              Total Match Count:{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {totalMatches.toLocaleString()}
              </span>
            </div>
            <div>
              Total Venue Cost (per-row):{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {fmtMoney(totalCost, true)}
              </span>
            </div>
          </div>
        </div>
      </section>
      )}

      <ScheduleRowEditor
        open={editorOpen}
        mode={editorMode}
        initial={editorRow}
        addPrefill={editorPrefill}
        venues={data?.venues ?? []}
        overrides={data?.overrides ?? []}
        onClose={() => {
          setEditorOpen(false);
          setEditorPrefill(null);
        }}
        onSubmit={handleSubmit}
      />

      <ScheduleBulkAddEditor
        open={bulkOpen}
        venues={data?.venues ?? []}
        overrides={data?.overrides ?? []}
        onClose={() => setBulkOpen(false)}
        onSubmit={handleBulkSubmit}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteRow)}
        title="Delete this schedule row?"
        summary={
          deleteRow ? (
            <div className="space-y-1 text-xs">
              <div className="font-mono">
                {deleteRow.date} · {deleteRow.venue} · {deleteRow.city}
              </div>
              <div>
                <span className="font-mono font-bold">
                  {deleteRow.match_count}
                </span>{" "}
                match{deleteRow.match_count === 1 ? "" : "es"}
                {deleteRow.venue_cost != null && (
                  <>
                    {" "}
                    · {fmtMoney(deleteRow.venue_cost, true)} venue cost
                  </>
                )}
              </div>
              {deleteRow.notes && (
                <div className="text-deep-green/55">{deleteRow.notes}</div>
              )}
              {!deleteRow.manual_entry && (
                <div className="mt-2 rounded-md border border-gold/40 bg-gold-soft/40 px-2 py-1 text-coral">
                  This row was imported from the Sheet. It will reappear next
                  time you import {monthFromDate(deleteRow.date)} unless you
                  remove it from the Sheet too.
                </div>
              )}
            </div>
          ) : null
        }
        onCancel={() => setDeleteRow(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}

function Filter({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
        {label}
      </div>
      {children}
    </label>
  );
}

function Th({
  label,
  align = "left",
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: "left" | "right";
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className={`cursor-pointer select-none px-3 py-2 ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-deep-green" : ""} hover:bg-cream`}
    >
      <span
        className={`inline-flex items-center gap-1 ${
          align === "right" ? "justify-end" : ""
        }`}
      >
        {label}
        {active && <span aria-hidden>{dir === "desc" ? "▼" : "▲"}</span>}
      </span>
    </th>
  );
}
