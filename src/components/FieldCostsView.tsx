"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Lock,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import AddVenueDialog, { type AddVenueDraft } from "@/components/AddVenueDialog";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import { logChange } from "@/lib/financeAudit";
import {
  buildFieldCostRows,
  fieldCostsFor,
  isEventSchedule,
  overrideOnlyTotalFor,
  perMatchTotalFor,
  totalOverrideAmountFor,
  type FieldCostRow,
} from "@/lib/financeCosts";
import { useFinanceQuarter } from "@/lib/financeQuarter";
// THE SINGLE BILLING-DATE DERIVATION — the same call OpEx makes. See its note in opexSources.ts.
import { resolveBillingDates } from "@/lib/opexSources";
import {
  getCurrentMonthInQuarter,
  type Q2Month,
} from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import {
  patchOverrideOptimistic,
  patchVenueOptimistic,
  refetchFinanceData,
  useFinanceData,
  type FinanceData,
  type FinVenue,
  type FinVenueCostOverride,
} from "@/lib/useFinanceData";

// TWO RATE COLUMNS, TWO DIFFERENT FACTS — neither is a stale copy of the other.
//   cost_per_match  = the rate AGREED with the venue. Reference data, read deliberately.
//   per_match_rate  = whether we AUTO-BILL per match. NULL is a real answer: not auto-billed,
//                     so a month with no override correctly costs $0 (financeCosts.ts:136
//                     `venue.per_match_rate ?? 0`), and which months were $0 is a thing this
//                     page is read for.
// The panel labels them apart. Never write one from the other.
// savePrice is column-generic, so this needs no new write path.
type PriceField = "dpp_price" | "member_price" | "cost_per_match" | "per_match_rate";
type EditableField =
  | PriceField
  | "billing_type"
  | "charge_on_cancel"
  | "billing_cadence"
  | "billing_day"
  | "billing_anchor_month"
  | "billing_weekday"
  | "billing_custom_days";
// "custom_amount" is a virtual key for the CUSTOM cadence's per-month
// amount cell — it writes fin_venue_cost_overrides, not a fin_venues
// column, but shares the same saving/flash/error cell-state map.
type CellStateKey = EditableField | "custom_amount";
type CellState = { saving: boolean; error: string | null; flash: boolean };
type EditMap = Map<string, CellState>;

// ── DISPLAY HELPERS FOR THE REBUILT TABLE ──────────────────────────────────────────────────────
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// "Aug 2026" → "Aug"
function monthShort(monthKey: string): string { return monthKey.split(" ")[0] ?? monthKey; }
function monthFull(monthKey: string): string {
  const i = MONTHS_SHORT.indexOf(monthShort(monthKey));
  return i < 0 ? monthKey : MONTHS_FULL[i];
}
function monthParts(monthKey: string): { year: number; month0: number } | null {
  const [mon, yr] = monthKey.split(" ");
  const m = MONTHS_SHORT.indexOf(mon);
  const y = Number(yr);
  return m < 0 || !Number.isFinite(y) ? null : { year: y, month0: m };
}
// THE DATE COMES FROM opexSources, NEVER FROM THIS FILE. resolveBillingDates is the single
// derivation — the same call OpEx makes to decide where the money lands. This file previously
// re-derived it from billing_day alone, which is wrong for CUSTOM cadence (that reads
// billing_custom_days and ignores billing_day entirely), so five venues showed a date the money
// does not land on. Billing is SAME-MONTH, so the date is always in the month above it.
function billingDatesFor(venue: FinVenue | null, monthKey: string): { labels: string[]; cadence: string } {
  const p = monthParts(monthKey);
  if (!p) return { labels: [], cadence: "monthly" };
  const { days, cadence } = resolveBillingDates(venue, p.year, p.month0);
  return { labels: days.map((d) => `${MONTHS_SHORT[p.month0]} ${d}`), cadence };
}
const BILLING_LABEL: Record<string, string> = {
  per_match: "Per match",
  profit_share: "Profit share",
  monthly_flat: "Monthly flat",
};

function editKey(venueId: number, field: CellStateKey): string {
  return `${venueId}|${field}`;
}

const BILLING_TYPE_OPTIONS: FinVenue["billing_type"][] = [
  "per_match",
  "monthly_flat",
  "profit_share",
];

type BillingFilter =
  | "ALL"
  | FinVenue["billing_type"]
  | "OVERRIDE";

const ALL = "ALL";

function fmtMoney(n: number, signZero = false): string {
  const r = Math.round(n);
  if (r === 0 && !signZero) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

export default function FieldCostsView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();

  const [month, setMonth] = useState<Q2Month>(
    () =>
      getCurrentMonthInQuarter(quarter, new Date()) ??
      quarter.months[quarter.months.length - 1].key,
  );
  useEffect(() => {
    if (!quarter.months.some((m) => m.key === month)) {
      setMonth(
        getCurrentMonthInQuarter(quarter, new Date()) ??
          quarter.months[quarter.months.length - 1].key,
      );
    }
  }, [quarter, month]);
  const [cityFilter, setCityFilter] = useState<string>(ALL);
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("ALL");
  const [hasOverrideOnly, setHasOverrideOnly] = useState(false);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);



  const [addVenueOpen, setAddVenueOpen] = useState(false);
  // After a successful Add Venue, surface a banner + flash the new
  // row. lastAdded.venueId drives the `highlight` prop on
  // FieldCostTableRow. Cleared by the banner's dismiss or after the
  // post-save toast linger.
  const [lastAdded, setLastAdded] = useState<{
    venueId: number;
    venueName: string;
    city: string;
  } | null>(null);
  const [addVenueError, setAddVenueError] = useState<string | null>(null);

  const [edits, setEdits] = useState<EditMap>(new Map());

  const venueById = useMemo(() => {
    const m = new Map<number, FinVenue>();
    for (const v of data?.venues ?? []) m.set(v.id, v);
    return m;
  }, [data?.venues]);

  function setEditState(key: string, state: CellState | null) {
    setEdits((m) => {
      const next = new Map(m);
      if (state === null) next.delete(key);
      else next.set(key, state);
      return next;
    });
  }

  async function saveVenueField(
    venueId: number,
    field: EditableField,
    nextValue: number | string | boolean | null | Record<string, number[]>,
    parsedValid: boolean,
  ): Promise<void> {
    const email = appUser?.email;
    const venue = venueById.get(venueId);
    if (!email || !venue) return;
    const key = editKey(venueId, field);
    if (!parsedValid) {
      setEditState(key, { saving: false, error: "Invalid value.", flash: false });
      return;
    }
    const oldValue = venue[field];
    const before: Record<string, unknown> = { id: venue.id, [field]: oldValue };

    // Optimistic: swap this one field in the cached row now, so the cell
    // and this row's derived cost/warnings update in place. No cache clear,
    // no reload, no lost scroll. Persist in the background; roll back on
    // failure.
    patchVenueOptimistic(venueId, { [field]: nextValue } as Partial<FinVenue>);
    setEditState(key, { saving: true, error: null, flash: false });
    try {
      const { data: updated, error } = await supabase
        .from("fin_venues")
        .update({ [field]: nextValue })
        .eq("id", venueId)
        .select()
        .single();
      if (error) throw error;
      await logChange({
        tableName: "fin_venues",
        rowId: venueId,
        action: "update",
        changedBy: email,
        before,
        after: updated as Record<string, unknown>,
      });
      setEditState(key, { saving: false, error: null, flash: true });
      // Clear flash + state after the animation settles.
      setTimeout(() => setEditState(key, null), 900);
    } catch (e) {
      // Revert the optimistic change to the value we captured.
      patchVenueOptimistic(venueId, { [field]: oldValue } as Partial<FinVenue>);
      setEditState(key, {
        saving: false,
        error: e instanceof Error ? e.message : "Save failed.",
        flash: false,
      });
    }
  }

  function savePrice(venueId: number, field: PriceField, raw: string): void {
    const trimmed = raw.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    const valid = parsed === null || (!Number.isNaN(parsed) && parsed >= 0);
    void saveVenueField(venueId, field, parsed, valid);
  }

  function saveBillingType(
    venueId: number,
    nextValue: FinVenue["billing_type"],
  ): void {
    const valid = BILLING_TYPE_OPTIONS.includes(nextValue);
    void saveVenueField(venueId, "billing_type", nextValue, valid);
  }

  function saveChargeOnCancel(venueId: number, next: boolean): void {
    void saveVenueField(venueId, "charge_on_cancel", next, true);
  }

  // OpEx billing-timing edits (migration 0069). These place a
  // flat/quarterly venue's monthly cost on a real day in the OpEx
  // calendar; they don't affect any cost total here.
  function saveBillingCadence(
    venueId: number,
    next: FinVenue["billing_cadence"],
  ): void {
    void saveVenueField(venueId, "billing_cadence", next, true);
  }
  function saveBillingDay(venueId: number, raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === "") {
      void saveVenueField(venueId, "billing_day", null, true);
      return;
    }
    const n = parseInt(trimmed, 10);
    const valid = Number.isInteger(n) && n >= 1 && n <= 31;
    void saveVenueField(venueId, "billing_day", valid ? n : trimmed, valid);
  }
  function saveBillingAnchorMonth(venueId: number, raw: string): void {
    if (raw === "") {
      void saveVenueField(venueId, "billing_anchor_month", null, true);
      return;
    }
    const n = parseInt(raw, 10);
    const valid = Number.isInteger(n) && n >= 1 && n <= 12;
    void saveVenueField(venueId, "billing_anchor_month", valid ? n : raw, valid);
  }
  // WEEKLY cadence (migration 0070): day of week 0=Sun..6=Sat.
  function saveBillingWeekday(venueId: number, raw: string): void {
    if (raw === "") {
      void saveVenueField(venueId, "billing_weekday", null, true);
      return;
    }
    const n = parseInt(raw, 10);
    const valid = Number.isInteger(n) && n >= 0 && n <= 6;
    void saveVenueField(venueId, "billing_weekday", valid ? n : raw, valid);
  }
  // CUSTOM cadence (migration 0070): set/clear the current month's entry in
  // the venue's per-month billing_custom_days map. Reads the whole map,
  // updates one ISO-month key, writes it back (jsonb column).
  function saveCustomDays(venueId: number, monthIso: string, days: number[]): void {
    const venue = venueById.get(venueId);
    if (!venue) return;
    const next: Record<string, number[]> = { ...(venue.billing_custom_days ?? {}) };
    if (days.length === 0) delete next[monthIso];
    else next[monthIso] = days;
    void saveVenueField(venueId, "billing_custom_days", next, true);
  }
  // Write (or clear) one fin_venue_cost_overrides row for (venue, month),
  // optimistically, with an audit entry. amount null = delete. Shared by the
  // primary write and the combined-venue secondary mirror.
  async function writeOneOverride(
    venueId: number,
    forMonth: Q2Month,
    amount: number | null,
    reason: string | null,
    email: string,
  ): Promise<void> {
    const existing =
      data?.overrides.find(
        (o) => o.venue_id === venueId && o.month === forMonth,
      ) ?? null;
    if (amount == null) {
      if (!existing) return;
      await logChange({
        tableName: "fin_venue_cost_overrides",
        rowId: existing.id,
        action: "delete",
        changedBy: email,
        before: existing as unknown as Record<string, unknown>,
      });
      const { error } = await supabase
        .from("fin_venue_cost_overrides")
        .delete()
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      patchOverrideOptimistic({ type: "remove", venueId, month: forMonth });
      return;
    }
    if (existing) {
      const { data: updated, error } = await supabase
        .from("fin_venue_cost_overrides")
        .update({ override_amount: amount, reason })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_venue_cost_overrides",
        rowId: existing.id,
        action: "update",
        changedBy: email,
        before: existing as unknown as Record<string, unknown>,
        after: updated as Record<string, unknown>,
      });
      patchOverrideOptimistic({ type: "upsert", row: updated as FinVenueCostOverride });
    } else {
      const { data: inserted, error } = await supabase
        .from("fin_venue_cost_overrides")
        .insert({
          venue_id: venueId,
          month: forMonth,
          override_amount: amount,
          reason,
          created_by: email,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_venue_cost_overrides",
        rowId: (inserted as { id: number }).id,
        action: "insert",
        changedBy: email,
        after: inserted as Record<string, unknown>,
      });
      patchOverrideOptimistic({ type: "upsert", row: inserted as FinVenueCostOverride });
    }
  }

  // CUSTOM cadence amount for the current month — works for ANY billing type
  // (per_match included). Writes the per-month override on THIS venue so
  // buildFieldCostRows, OpEx and Cash Flow all read the same number; empty
  // clears it back to auto. For a combined venue the override covers the
  // primary leg only — secondary legs bill their own cost. To mark a
  // secondary as covered by the primary invoice, set an explicit $0 override
  // on that leg (no auto-mirror).
  async function saveCustomAmount(
    venueId: number,
    forMonth: Q2Month,
    raw: string,
  ): Promise<void> {
    const email = appUser?.email;
    if (!email) return;
    const key = editKey(venueId, "custom_amount");
    const trimmed = raw.trim();
    setEditState(key, { saving: true, error: null, flash: false });
    try {
      if (trimmed === "") {
        await writeOneOverride(venueId, forMonth, null, null, email);
      } else {
        const amount = parseFloat(trimmed);
        if (Number.isNaN(amount) || amount < 0) {
          setEditState(key, { saving: false, error: "Invalid amount.", flash: false });
          return;
        }
        await writeOneOverride(venueId, forMonth, amount, "Custom billing month", email);
      }
      setEditState(key, { saving: false, error: null, flash: true });
      setTimeout(() => setEditState(key, null), 900);
    } catch (e) {
      setEditState(key, {
        saving: false,
        error: e instanceof Error ? e.message : "Save failed.",
        flash: false,
      });
    }
  }

  // Venues whose cost is a partner-dashboard payout (Crossbar's
  // per_match_minus_manager) are stored as per_match but can't be dated
  // off the schedule, so they DO get a billing-timing editor like
  // flat/profit_share venues.
  const dashboardDrivenIds = useMemo(() => {
    const s = new Set<number>();
    for (const d of data?.partnerDashboards ?? []) {
      if (d.revenueModel === "per_match_minus_manager") s.add(d.venueId);
    }
    return s;
  }, [data?.partnerDashboards]);

  const allRows: FieldCostRow[] = useMemo(() => {
    if (!data) return [];
    return buildFieldCostRows(data, month);
  }, [data, month]);

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.city);
    return [ALL, ...[...set].sort()];
  }, [allRows]);

  const filtered = useMemo(() => {
    let rows = allRows.slice();
    if (cityFilter !== ALL) rows = rows.filter((r) => r.city === cityFilter);
    if (billingFilter === "OVERRIDE") {
      rows = rows.filter((r) => r.override !== null);
    } else if (billingFilter !== "ALL") {
      rows = rows.filter((r) => r.billingType === billingFilter);
    }
    if (hasOverrideOnly) rows = rows.filter((r) => r.override !== null);
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [allRows, cityFilter, billingFilter, hasOverrideOnly]);

  // Reconciliation: fieldCostsFor is now the canonical Cash Flow line, so
  // its sum always matches the per-row total here by construction. We
  // surface the breakdown for trust — per-match auto, override-billed,
  // raw override count — so a glance confirms the page is reading from
  // the same place Cash Flow renders.
  const recon = useMemo(() => {
    if (!data) return null;
    const fieldTotal = allRows.reduce((s, r) => s + r.amount, 0);
    const cashFlowTotal = fieldCostsFor(data, month);
    const filteredTotal = filtered.reduce((s, r) => s + r.amount, 0);
    const perMatch = perMatchTotalFor(data, month);
    const overrideInfo = totalOverrideAmountFor(data, month);
    const overrideRaw = overrideOnlyTotalFor(data, month);
    const perMatchVenueCount = data.venues.filter(
      (v) => v.billing_type === "per_match",
    ).length;
    const totalMatchCount = allRows.reduce((s, r) => s + r.matchCount, 0);
    return {
      fieldTotal,
      cashFlowTotal,
      filteredTotal,
      diff: fieldTotal - cashFlowTotal,
      perMatch,
      overrideInfo,
      overrideRaw,
      perMatchVenueCount,
      totalMatchCount,
    };
  }, [allRows, filtered, data, month]);

  async function handleSubmitAddVenue(draft: AddVenueDraft) {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");

    // 1. Insert the venue. is_active=true. Aliases (if any) are
    //    written separately below — a unique index on
    //    (city, venue_name) will surface duplicates with a
    //    23505 / "duplicate key" error which we translate to a
    //    friendlier message. Note: FinVenue.raw_venue_name is a
    //    hydrator-derived field (set from venue_name pre-alias in
    //    useFinanceData's mapper); it is NOT a real DB column, so
    //    we do not send it in the INSERT payload.
    const payload = {
      venue_name: draft.venue_name,
      city: draft.city,
      billing_type: draft.billing_type,
      per_match_rate: draft.per_match_rate,
      hourly_rate: draft.hourly_rate,
      cost_per_match: draft.cost_per_match,
      max_spots: draft.max_spots,
      dpp_price: draft.dpp_price,
      member_price: draft.member_price,
      launch_date: draft.launch_date,
      notes: draft.notes,
      is_active: true,
    };
    const { data: inserted, error } = await supabase
      .from("fin_venues")
      .insert(payload)
      .select()
      .single();
    if (error) {
      if (
        error.code === "23505" ||
        /duplicate key/i.test(error.message ?? "")
      ) {
        throw new Error(
          `A venue named "${draft.venue_name}" already exists in ${draft.city}. ` +
            `Use a unique name or edit the existing entry.`,
        );
      }
      throw new Error(error.message);
    }
    const insertedVenue = inserted as { id: number } & Record<string, unknown>;

    // 2. If the operator supplied a canonical mdapi field_id, link
    //    it via fin_venue_fields. Best-effort — a duplicate field_id
    //    (UNIQUE violation) or any other failure surfaces as a
    //    partial-success banner so the venue row still exists and
    //    can be linked later from Supabase Studio.
    if (draft.mdapi_field_id != null) {
      const { error: linkErr } = await supabase
        .from("fin_venue_fields")
        .insert({
          fin_venue_id: insertedVenue.id,
          mdapi_field_id: draft.mdapi_field_id,
          field_title_at_link: draft.venue_name,
        });
      if (linkErr) {
        setAddVenueError(
          `Venue added, but mdapi field link failed: ${linkErr.message}. ` +
            `Add the fin_venue_fields row manually from Supabase Studio.`,
        );
      }
    }

    // 3. Insert aliases (if any). Schema: fin_venue_aliases (id, alias,
    //    canonical_venue, created_at). One row per comma-separated
    //    entry. Best-effort: a failure here doesn't roll back the
    //    venue insert — the venue still exists and the operator can
    //    add aliases later from Supabase Studio.
    if (draft.aliases.length > 0) {
      const aliasRows = draft.aliases.map((alias) => ({
        alias,
        canonical_venue: draft.venue_name,
      }));
      const { error: aliasErr } = await supabase
        .from("fin_venue_aliases")
        .insert(aliasRows);
      if (aliasErr) {
        // Don't throw — the venue is created. Surface the partial
        // failure in the banner.
        setAddVenueError(
          `Venue added, but alias insert failed: ${aliasErr.message}. ` +
            `Add aliases manually from Supabase Studio.`,
        );
      }
    }

    // 4. Audit log.
    await logChange({
      tableName: "fin_venues",
      rowId: insertedVenue.id,
      action: "insert",
      changedBy: email,
      after: insertedVenue,
    });

    await refetchFinanceData();
    setAddVenueOpen(false);
    setLastAdded({
      venueId: insertedVenue.id,
      venueName: draft.venue_name,
      city: draft.city,
    });
    // Banner + row highlight auto-dismiss after 12 seconds so the
    // operator has time to read the "Add to Billing Schedule" CTA.
    setTimeout(() => setLastAdded(null), 12000);
  }


  return (
    <>
      <div className="mb-6 text-sm">
      </div>

      <div className="mb-6">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Field Costs
        </h1>

      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Month">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value as Q2Month)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {quarter.months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.key}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="City">
          <select
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {cityOptions.map((c) => (
              <option key={c} value={c}>
                {c === ALL ? "All" : c}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="Billing Type">
          <select
            value={billingFilter}
            onChange={(e) =>
              setBillingFilter(e.target.value as BillingFilter)
            }
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All</option>
            {BILLING_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
            <option value="OVERRIDE">Month value</option>
          </select>
        </Filter>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-deep-green/75">
          <input
            type="checkbox"
            checked={hasOverrideOnly}
            onChange={(e) => setHasOverrideOnly(e.target.checked)}
          />
          Has a month value only
        </label>
        <button
          type="button"
          onClick={() => {
            setAddVenueError(null);
            setAddVenueOpen(true);
          }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
        >
          <Plus size={14} aria-hidden />
          Add Venue
        </button>
      </div>

      {lastAdded && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-mint/50 bg-mint-soft/40 px-4 py-3 text-sm text-deep-green">
          <div>
            <span className="font-bold">{lastAdded.venueName}</span>
            <span className="text-deep-green/70"> · {lastAdded.city}</span>
            <span className="text-deep-green/70"> · added.</span>
            {addVenueError && (
              <div className="mt-1 text-xs text-coral">{addVenueError}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setLastAdded(null);
                setAddVenueError(null);
              }}
              className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green/65 hover:bg-cream-soft"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {recon && Math.abs(recon.diff) > 1 && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft/40 px-4 py-3 text-sm text-coral">
          <strong>⚠️ Field Costs total ({fmtMoney(recon.fieldTotal, true)})</strong>{" "}
          doesn't match Monthly Cash Flow venue costs (
          {fmtMoney(recon.cashFlowTotal, true)}) for {month}. Difference:{" "}
          {fmtMoney(recon.diff, true)}. Investigate before publishing reports.
        </div>
      )}

      {/* THE ONE LINE OF PROSE THIS PAGE KEEPS, because it is the rule. SAME-MONTH: opexSources.ts
          keys the cost to monthKeyFor(year, month0) (:540) and resolves the day against that same
          month0 (:435) — there is no +1 on that path. */}
      <div className="mb-4 rounded-lg border border-cream-line border-l-[3px] border-l-deep-green/20 bg-[#f7faf8] px-3.5 py-2.5 text-[12.5px] text-deep-green/70">
        <b className="font-extrabold text-deep-green">Monthly venues bill within the month.</b>{" "}
        {monthFull(month)}&rsquo;s field cost is dated in {monthFull(month)}, on the venue&rsquo;s
        billing day. Per-match venues cost on each match date and have no billing day.
      </div>

      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              {/* SEVEN COLUMNS. City folded into Venue; Pay-on-cancel folded into the Rate
                  sub-line; DPP and Member price moved into the row panel — they are what a PLAYER
                  pays, and they held the two widest columns on a table about what MatchDay pays. */}
              <tr className="border-b border-cream-line">
                <th className="px-3 py-2 pl-5 text-left">Venue</th>
                <th className="px-3 py-2 text-left">Billing</th>
                <th className="px-3 py-2 text-left">Rate</th>
                <th className="px-3 py-2 text-right">Matches</th>
                <th className="px-3 py-2 text-right">{monthShort(month)} cost</th>
                <th className="px-3 py-2 text-left">
                  Bills on
                  <span className="block text-[8.5px] font-bold normal-case tracking-normal text-deep-green/35">
                    when the money leaves
                  </span>
                </th>
                <th className="w-8 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading field costs…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    No venues match these filters.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => {
                  const expanded = expandedKey === row.key;
                  const expandable =
                    row.billingType === "per_match" && row.legs.length > 0;
                  const primaryVenue = venueById.get(row.primaryVenueId) ?? null;
                  return (
                    <FieldCostTableRow
                      key={row.key}
                      row={row}
                      expanded={expanded}
                      expandable={expandable}
                      onToggleExpand={() =>
                        setExpandedKey(expanded ? null : row.key)
                      }
                      primaryVenue={primaryVenue}
                      highlight={
                        lastAdded?.venueId === row.primaryVenueId
                      }
                      cellState={(field) =>
                        edits.get(editKey(row.primaryVenueId, field)) ?? null
                      }
                      onSavePrice={(field, raw) =>
                        savePrice(row.primaryVenueId, field, raw)
                      }
                      onSaveBillingType={(next) =>
                        saveBillingType(row.primaryVenueId, next)
                      }
                      onSaveChargeOnCancel={(next) =>
                        saveChargeOnCancel(row.primaryVenueId, next)
                      }
                      dashboardDriven={dashboardDrivenIds.has(row.primaryVenueId)}
                      onSaveBillingCadence={(next) =>
                        saveBillingCadence(row.primaryVenueId, next)
                      }
                      onSaveBillingDay={(raw) =>
                        saveBillingDay(row.primaryVenueId, raw)
                      }
                      onSaveBillingAnchorMonth={(raw) =>
                        saveBillingAnchorMonth(row.primaryVenueId, raw)
                      }
                      onSaveBillingWeekday={(raw) =>
                        saveBillingWeekday(row.primaryVenueId, raw)
                      }
                      onSaveCustomDays={(iso, days) =>
                        saveCustomDays(row.primaryVenueId, iso, days)
                      }
                      onSaveCustomAmount={(raw) =>
                        void saveCustomAmount(row.primaryVenueId, month, raw)
                      }
                      isCombinedPrimary={row.secondaryVenueIds.length > 0}
                      month={month}
                      autoAmount={row.autoAmount}
                      scheduleRows={
                        data ? buildMatchLineItems(data, row, month) : []
                      }
                    />
                  );
                })
              )}
            </tbody>
            <tfoot className="border-t-2 border-deep-green bg-[#fbfdfc] text-deep-green">
              <tr>
                <td className="px-3 py-3.5 pl-5 text-left text-[15px] font-extrabold">{monthFull(month)}</td>
                <td /><td />
                <td className="px-3 py-3.5 text-right text-[15px] font-extrabold tabular-nums">
                  {filtered.reduce((a, r) => a + r.matchCount, 0)}
                </td>
                {/* THE SAME SUM AS THE HEADLINE — both are the rows on screen, so they cannot drift. */}
                <td className="px-3 py-3.5 text-right text-[19px] font-extrabold tabular-nums">
                  {fmtMoney(filtered.reduce((a, r) => a + r.amount, 0))}
                </td>
                <td /><td />
              </tr>
            </tfoot>
          </table>
        </div>
        {recon && (
          <div className="border-t border-cream-line/60 bg-cream-soft/40 px-4 py-3 text-xs text-deep-green/75">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                Total Field Costs (filtered):{" "}
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.filteredTotal, true)}
                </span>
                {filtered.length !== allRows.length && (
                  <span className="ml-2 text-[10px] text-deep-green/55">
                    · Month total: {fmtMoney(recon.fieldTotal, true)}
                  </span>
                )}
              </div>
              <div className="text-[10px]">
                Cash Flow Field Costs ({month}):{" "}
                <span className="font-mono">
                  {fmtMoney(recon.cashFlowTotal, true)}
                </span>
                {Math.abs(recon.diff) <= 1 && (
                  <span className="ml-2 text-mint-hover">✓ reconciles</span>
                )}
              </div>
            </div>
            <ul className="mt-2 space-y-0.5 pl-2 text-[11px]">
              <li className="flex items-baseline gap-2">
                <span className="text-deep-green/55">•</span>
                <span>Per-match auto-computed:</span>
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.perMatch, true)}
                </span>
                <span className="text-deep-green/55">
                  ({recon.perMatchVenueCount} venues, {recon.totalMatchCount}{" "}
                  matches)
                </span>
              </li>
              <li className="flex items-baseline gap-2">
                <span className="text-deep-green/55">•</span>
                <span>Hand-entered month values ({month}):</span>
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.overrideRaw, true)}
                </span>
                <span className="text-deep-green/55">
                  ({recon.overrideInfo.venueCount} venues)
                </span>
              </li>
            </ul>
          </div>
        )}
      </section>

      <AddVenueDialog
        open={addVenueOpen}
        onClose={() => setAddVenueOpen(false)}
        onSubmit={handleSubmitAddVenue}
      />


    </>
  );
}

function FieldCostTableRow({
  row,
  expanded,
  expandable,
  onToggleExpand,
  primaryVenue,
  cellState,
  onSavePrice,
  onSaveBillingType,
  onSaveChargeOnCancel,
  dashboardDriven,
  onSaveBillingCadence,
  onSaveBillingDay,
  onSaveBillingAnchorMonth,
  onSaveBillingWeekday,
  onSaveCustomDays,
  onSaveCustomAmount,
  isCombinedPrimary,
  month,
  autoAmount,
  scheduleRows,
  highlight,
}: {
  row: FieldCostRow;
  expanded: boolean;
  expandable: boolean;
  onToggleExpand: () => void;
  primaryVenue: FinVenue | null;
  cellState: (field: CellStateKey) => CellState | null;
  onSavePrice: (field: PriceField, raw: string) => void;
  onSaveBillingType: (next: FinVenue["billing_type"]) => void;
  onSaveChargeOnCancel: (next: boolean) => void;
  dashboardDriven: boolean;
  onSaveBillingCadence: (next: FinVenue["billing_cadence"]) => void;
  onSaveBillingDay: (raw: string) => void;
  onSaveBillingAnchorMonth: (raw: string) => void;
  onSaveBillingWeekday: (raw: string) => void;
  onSaveCustomDays: (monthIso: string, days: number[]) => void;
  onSaveCustomAmount: (raw: string) => void;
  isCombinedPrimary: boolean;
  month: Q2Month;
  autoAmount: number;
  scheduleRows: MatchLineItem[];
  // Set briefly when the Match P&L tab links back to this row.
  // Renders a soft mint pulse so the operator can find the row.
  highlight?: boolean;
}) {
  const isOverride = Boolean(row.override);
  const isCombined = row.secondaryVenueIds.length > 0;
  const v = primaryVenue;
  const zero = Math.abs(row.amount) < 0.005;
  // An agreed rate on record — cost_per_match, or an auto-bill rate. Drives the "not billed"
  // sub-line and keeps a genuinely rate-less venue from claiming one.
  const hasAgreedRate = (v?.cost_per_match ?? null) !== null || (v?.per_match_rate ?? null) !== null;

  // THE AGREED RATE IS REFERENCE DATA, NOT A BUG.
  //
  // cost_per_match is the rate AGREED WITH THE VENUE. per_match_rate is a different fact: whether
  // we auto-bill per match. A NULL per_match_rate is INTENTIONAL — it means the venue is not
  // auto-billed per match, so a month with no override correctly costs $0, and "which months were
  // $0" is something this page is read for.
  //
  // So the cell shows the agreed rate, LABELLED so it cannot be mistaken for what drives the cost.
  // An agreed rate differing from what we paid this month is normal.
  let rateMain: React.ReactNode;
  let rateSub = v?.charge_on_cancel ? "cancelled matches billed" : "cancels not billed";
  // NO AMBER ON THIS CELL. A rate that differs from what we paid this month is normal under this
  // model, not a fault, so there is no warning state left for the rate to be in.
  if (row.billingType === "per_match") {
    if (v?.cost_per_match === 0 || v?.per_match_rate === 0) {
      rateMain = "Free";
      rateSub = "no charge from venue";
    } else if (v?.per_match_rate != null) {
      rateMain = <>{fmtMoney(v.per_match_rate)} <span className="font-semibold text-deep-green/45">/ match</span></>;
    } else if (v?.cost_per_match != null) {
      // Agreed, but not auto-billed — the cost comes from a monthly override instead.
      rateMain = <>{fmtMoney(v.cost_per_match)} <span className="font-semibold text-deep-green/45">/ match agreed</span></>;
      rateSub = "billed monthly, not per match";
    } else {
      rateMain = <span className="text-deep-green/40">—</span>;
      rateSub = "no rate on record";
    }
  } else if (row.billingType === "profit_share") {
    rateMain = <>Share <span className="font-semibold text-deep-green/45">of revenue</span></>;
  } else {
    rateMain = v?.monthly_flat != null
      ? <>{fmtMoney(v.monthly_flat)} <span className="font-semibold text-deep-green/45">/ month</span></>
      : <span className="text-deep-green/40">Per month</span>;
    rateSub = "flat, regardless of matches";
  }

  // BILLS ON — three states, and only three.
  const perMatchDated = row.billingType === "per_match" && v?.billing_day == null;
  const bill = billingDatesFor(v, month);
  // RED ONLY WHERE MONEY IS. A month with no billing is normal under this model, so an undated $0
  // is not an error — it is the ordinary case. The cell turns red on its own the month the venue
  // actually carries cost, which is the state worth interrupting for.
  const undatedWithMoney = !perMatchDated && bill.labels.length === 0 && !zero;
  return (
    <>
      <tr
        id={`venue-row-${row.primaryVenueId}`}
        className={
          "border-b border-cream-line/70 transition " +
          (expanded ? "bg-cream-soft/40" : "hover:bg-cream-soft/30") +
          (highlight ? " animate-pulse bg-mint/20" : "")
        }
      >
        {/* VENUE — city (and "combined") as a sub-line. Kills the separate City column. */}
        <td className="px-3 py-2.5 pl-5">
          <div className="text-[14.5px] font-bold text-deep-green">{row.displayName}</div>
          <div className="mt-0.5 text-[11px] text-deep-green/45">
            {row.city}{isCombined ? " · combined" : ""}
          </div>
        </td>

        {/* BILLING — a quiet tag, title case, never the raw enum. */}
        <td className="px-3 py-2.5">
          <span className="inline-block whitespace-nowrap rounded border border-cream-line bg-cream-soft px-[7px] py-[3px] text-[10px] font-extrabold uppercase tracking-[0.05em] text-deep-green/70">
            {BILLING_LABEL[row.billingType ?? ""] ?? "—"}
          </span>
        </td>

        {/* RATE — unit is part of the value; pay-on-cancel folded into the sub-line. */}
        <td className="px-3 py-2.5">
          <div className="text-[13.5px] font-bold text-deep-green">{rateMain}</div>
          <div className="mt-0.5 text-[11px] text-deep-green/45">{rateSub}</div>
        </td>

        <td className={"px-3 py-2.5 text-right tabular-nums " + (row.matchCount === 0 ? "text-deep-green/30" : "text-deep-green")}>
          {row.matchCount}
        </td>

        {/* MONTH COST — dim when zero. An amber sub-line only when the figure was entered by hand,
            and it only claims an auto figure for a billing type that HAS one. */}
        <td className="px-3 py-2.5 text-right">
          <div className={zero ? "text-[15px] font-semibold tabular-nums text-deep-green/30" : "text-[15px] font-extrabold tabular-nums text-deep-green"}>
            {fmtMoney(row.amount)}
          </div>
          {isOverride ? (
            <div className="mt-0.5 text-[10.5px] font-bold text-[#8a5a00]">
              {row.billingType === "per_match"
                ? `set for ${monthFull(month)} · auto ${fmtMoney(autoAmount)}`
                : `set for ${monthFull(month)}`}
            </div>
          ) : zero && hasAgreedRate ? (
            // THE STATE RYAN SCANS FOR. Plain, uncoloured: a venue with an agreed rate that we did
            // not bill this month. Normal, not a warning.
            <div className="mt-0.5 text-[10.5px] text-deep-green/40">
              not billed in {monthShort(month)}
            </div>
          ) : null}
        </td>

        {/* BILLS ON */}
        <td className={"px-3 py-2.5 " + (undatedWithMoney ? "bg-[#fdeceb]" : "")}>
          {perMatchDated ? (
            <>
              <div className="text-[13.5px] font-bold text-deep-green/70">On each match date</div>
              <div className="mt-0.5 text-[11px] text-deep-green/45">
                {row.matchCount === 0 ? `no matches in ${monthShort(month)}` : `${row.matchCount} dates in ${monthShort(month)}`}
              </div>
            </>
          ) : bill.labels.length > 0 ? (
            <>
              <div className="text-[14.5px] font-extrabold text-deep-green">{bill.labels.join(", ")}</div>
              <div className="mt-0.5 text-[11px] text-deep-green/45">
                {zero
                  ? "nothing to bill"
                  : bill.labels.length > 1
                    ? `${bill.labels.length} dates · ${bill.cadence}`
                    : bill.cadence}
              </div>
            </>
          ) : undatedWithMoney ? (
            <>
              {/* THE ONLY RED ON THE PAGE, and only when there is money to misplace. It is NOT
                  lost — it is in the month's subtotal (opexSources.ts:371) and lands on no day
                  (:437). */}
              <div className="text-[14.5px] font-extrabold text-[#a8321f]">No billing day</div>
              <div className="mt-0.5 text-[11px] font-bold text-[#a8321f]">
                in {monthFull(month)}&rsquo;s total, on no day
              </div>
            </>
          ) : (
            <div className="text-[13.5px] text-deep-green/40">not billed in {monthShort(month)}</div>
          )}
        </td>

        <td className="px-3 py-2.5 text-center text-deep-green/35">
          <button type="button" onClick={onToggleExpand} aria-expanded={expanded}
            className="px-1 text-base leading-none hover:text-deep-green">
            {expanded ? "⌄" : "›"}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-cream-line bg-[#fbfdfc]">
          <td colSpan={7} className="px-5 pb-5 pt-1">
            <VenuePanel
              row={row} venue={v} month={month} autoAmount={autoAmount}
              cellState={cellState} onSavePrice={onSavePrice}
              onSaveBillingType={onSaveBillingType}
              onSaveChargeOnCancel={onSaveChargeOnCancel}
              onSaveBillingDay={onSaveBillingDay}
              onSaveCustomAmount={onSaveCustomAmount}
              isOverride={isOverride}
              timing={
                // THE NON-MONTHLY EDITOR, PRESERVED. Seven venues are on `custom` cadence — five
                // of them active, carrying real billing_custom_days (NEMP {"2026-07":[29]},
                // Scissortail three months of them). BillingTimingCell is their ONLY editor for
                // cadence, anchor month, weekday and custom days; dropping it with the old table
                // would have deleted that ability silently.
                <BillingTimingCell
                  venue={v} dashboardDriven={dashboardDriven}
                  isCombinedPrimary={isCombinedPrimary} month={month}
                  autoAmount={autoAmount} monthOverride={row.override}
                  cadenceState={cellState("billing_cadence")} dayState={cellState("billing_day")}
                  anchorState={cellState("billing_anchor_month")} weekdayState={cellState("billing_weekday")}
                  customDaysState={cellState("billing_custom_days")} customAmountState={cellState("custom_amount")}
                  onSaveCadence={onSaveBillingCadence} onSaveDay={onSaveBillingDay}
                  onSaveAnchorMonth={onSaveBillingAnchorMonth} onSaveWeekday={onSaveBillingWeekday}
                  onSaveCustomDays={onSaveCustomDays} onSaveCustomAmount={onSaveCustomAmount}
                />
              }
            />
            {expandable && <PerMatchExpand row={row} scheduleRows={scheduleRows} />}
          </td>
        </tr>
      )}
    </>
  );
}



// ── THE ROW PANEL — this is where the boxes went ───────────────────────────────────────────────
//
// Nine venues by four editable fields was thirty-six bordered inputs on a page you mostly come to
// READ. The table is text now; every control lives here, in the row you opened.
//
// Three groups in one card: what MatchDay pays, when it bills, and what a PLAYER pays — the last
// labelled as not-a-cost, because it sat in the two widest columns of a cost table.
function VenuePanel({
  row, venue, month, autoAmount, cellState, onSavePrice, onSaveBillingType,
  onSaveChargeOnCancel, onSaveBillingDay, onSaveCustomAmount, isOverride, timing,
}: {
  row: FieldCostRow;
  venue: FinVenue | null;
  month: Q2Month;
  autoAmount: number;
  cellState: (field: CellStateKey) => CellState | null;
  onSavePrice: (field: PriceField, raw: string) => void;
  onSaveBillingType: (next: FinVenue["billing_type"]) => void;
  onSaveChargeOnCancel: (next: boolean) => void;
  onSaveBillingDay: (raw: string) => void;
  onSaveCustomAmount: (raw: string) => void;
  isOverride: boolean;
  timing: React.ReactNode;
}) {
  // AUTO-BILL IS per_match_rate BEING SET AT ALL. NULL means "not auto-billed per match", which is
  // a real, deliberate state for six venues — the money arrives as a monthly override instead.
  const autoBill = (venue?.per_match_rate ?? null) !== null;

  // ONE RATE, TWO COLUMNS. The agreed rate always lands in cost_per_match. per_match_rate mirrors
  // it while auto-bill is on and is cleared when it is off, so the switch and the stored shape can
  // never disagree. No value is invented for a venue that had none.
  const onSaveRate = (raw: string) => {
    onSavePrice("cost_per_match", raw);
    if (autoBill) onSavePrice("per_match_rate", raw);
  };
  const onToggleAutoBill = (next: boolean) => {
    // On → mirror the agreed rate. Off → NULL, never "0", which would be a real £0 rate.
    onSavePrice("per_match_rate", next ? String(venue?.cost_per_match ?? "") : "");
  };

  const day = venue?.billing_day ?? null;
  const nonMonthly = venue != null && venue.billing_cadence !== "monthly";
  const resolved = billingDatesFor(venue, month).labels.join(", ") || null;
  const glab = "mb-2.5 text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45";
  const fld = "mb-2 flex items-center gap-2.5";
  const lab = "w-[104px] flex-none text-[12.5px] font-semibold text-deep-green/60";
  const inp = "w-[130px] rounded-md border border-cream-line bg-white px-2 py-1.5 text-[13.5px] font-bold tabular-nums text-deep-green focus:border-deep-green focus:outline-none";

  // The days actually in use, so the select never omits a value the data already holds.
  // ANY DAY OF THE MONTH. This offered 1st, 5th, 15th, 28th and "Last day" — a shortlist that
  // could not express the day a real invoice actually falls on.
  //
  // 31 IS THE ONLY "LAST DAY" THERE IS. A separate "Last day" option stored 31 too, so the two
  // were the same row in the database wearing different labels — nothing downstream could tell
  // them apart, and a reader who picked one and saw the other on reload would be right to distrust
  // the control. There is one option now, labelled for what 31 does.
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-cream-line bg-white lg:grid-cols-3">
      {/* ── WHAT MATCHDAY PAYS ─────────────────────────────────────────────────────────────── */}
      <div className="border-b border-cream-line p-4 lg:border-b-0 lg:border-r">
        <div className={glab}>What MatchDay pays</div>
        <div className={fld}>
          <label className={lab}>Billing</label>
          <select
            value={row.billingType ?? "per_match"}
            onChange={(e) => onSaveBillingType(e.target.value as FinVenue["billing_type"])}
            className={inp + " w-[170px]"}
          >
            <option value="per_match">Per match</option>
            <option value="profit_share">Profit share</option>
            <option value="monthly_flat">Monthly flat</option>
          </select>
        </div>
        {row.billingType === "per_match" && (
          <>
            {/* ONE RATE AND A SWITCH, not two money boxes showing the same number.
                cost_per_match is the AGREED rate — reference. per_match_rate is whether we
                AUTO-BILL it against the match count. For ATH Katy both are $140, so the panel
                showed one figure twice under two labels with nothing to distinguish them.
                The columns are unchanged; this is the same two fields shown as what they mean. */}
            <div className={fld}>
              <label className={lab}>Rate</label>
              <PriceCell stored={venue?.cost_per_match ?? null} state={cellState("cost_per_match")}
                onSave={(raw) => onSaveRate(raw)} />
            </div>
            <div className={fld}>
              <label className={lab}>Auto-bill</label>
              <button type="button" role="switch" aria-checked={autoBill}
                data-testid="autobill-switch" disabled={cellState("per_match_rate")?.saving === true}
                onClick={() => onToggleAutoBill(!autoBill)}
                className={"relative h-[24px] w-[44px] flex-none rounded-full border transition "
                  + (autoBill ? "border-[#2fa36b] bg-[#cfeee0]" : "border-cream-line bg-white")}>
                <span className={"absolute top-[2px] h-[18px] w-[18px] rounded-full transition-all "
                  + (autoBill ? "left-[23px] bg-[#2fa36b]" : "left-[2px] bg-deep-green/30")} />
              </button>
              <span className="text-[12px] font-bold text-deep-green/60">{autoBill ? "On" : "Off"}</span>
            </div>
            {/* WHICH ONE IS IN FORCE, in this month's numbers. The switch says what the setting is;
                this says what it does to the money on screen. */}
            <div className="mb-2.5 ml-[116px] text-[11px] leading-snug text-deep-green/55"
              data-testid="autobill-effect">
              {autoBill
                // A COMBINED VENUE HAS LEGS AT DIFFERENT RATES — ATH Katy is $140 and its Sunday
                // leg $160, so "16 × $140" would not produce the $2,340 printed beside it. Where
                // the row is combined, the row's own formula is shown instead of a multiplication
                // that does not check out.
                ? (row.legs.length > 1
                    ? <>{monthFull(month)}: <b className="text-deep-green">{fmtMoney(row.autoAmount)}</b> — {row.autoFormula}</>
                    : <>{monthFull(month)}: {row.matchCount} match{row.matchCount === 1 ? "" : "es"}
                        {" × "}{fmtMoney(venue?.cost_per_match ?? 0)} = <b className="text-deep-green">{fmtMoney(row.autoAmount)}</b></>)
                : <>Billed monthly — {monthFull(month)}&rsquo;s cost comes from the month value below,
                    not the match count.</>}
            </div>
          </>
        )}
        <div className={fld}>
          <label className={lab}>Cancels</label>
          <select
            value={venue?.charge_on_cancel ? "yes" : "no"}
            onChange={(e) => onSaveChargeOnCancel(e.target.value === "yes")}
            className={inp + " w-[170px]"}
          >
            <option value="yes">Billed</option>
            <option value="no">Not billed</option>
          </select>
        </div>
        {/* ONE FIELD, ONE RULE. There is no "override" — there is a month box, and if there is a
            number in it that number is the cost. Empty with auto-bill on computes; empty with it
            off means nothing has been entered. That is the whole thing, so there is no Set button
            to press, no mode to be in, and nothing to name. */}
        <div className={fld}>
          <label className={lab}>{monthFull(month)} cost</label>
          <PriceCell
            stored={row.override?.override_amount ?? null}
            state={cellState("custom_amount")}
            onSave={(raw) => onSaveCustomAmount(raw)}
            // The placeholder is what leaving it empty actually produces.
            placeholder={autoBill ? `auto ${fmtMoney(autoAmount)}` : "—"}
            emptyOk={autoBill}
          />
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-deep-green/45" data-testid="month-help">
          {autoBill
            ? (row.legs.length > 1
                // autoFormula already ends with its own total — appending one printed it twice.
                ? <>Empty computes {row.autoFormula}.</>
                : <>Empty computes {row.matchCount} × {fmtMoney(venue?.cost_per_match ?? 0)} = <b className="text-deep-green/70">{fmtMoney(autoAmount)}</b>.</>)
            : <>This venue is not billed per match — enter {monthFull(month)}&rsquo;s cost.</>}
        </p>
      </div>

      {/* ── WHEN IT BILLS ──────────────────────────────────────────────────────────────────── */}
      <div className="border-b border-cream-line p-4 lg:border-b-0 lg:border-r">
        <div className={glab}>When it bills</div>
        {nonMonthly ? (
          <div className="mb-2">{timing}</div>
        ) : (
        <div className={fld}>
          <label className={lab}>Billing day</label>
          {/* A SELECT, not a number field. No timing toggle: the code has ONE behaviour
              (same-month), so a month-after option would be a control that does nothing. */}
          <select
            value={day == null ? "" : String(day)}
            onChange={(e) => onSaveBillingDay(e.target.value)}
            className={inp + " w-[170px]"}
          >
            <option value="">— not set —</option>
            {days.map((d) => (
              <option key={d} value={String(d)}>
                {d === 31 ? "31st — last day of the month" : ordinalDay(d)}
              </option>
            ))}
          </select>
        </div>
        )}
        <div className="mt-1 rounded-md bg-cream-soft px-2.5 py-2 text-[12.5px] text-deep-green/70">
          {resolved
            ? <>{monthFull(month)}&rsquo;s {fmtMoney(row.amount)} bills <b className="text-deep-green">{resolved}</b></>
            : <><b className="text-deep-green">{monthShort(month)} —</b> · pick a day to date it</>}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-deep-green/45">
          A day past the month&rsquo;s length is clamped to its last day, so the 31st resolves to the
          28th or 29th in February and the 30th in April. That is why there is no separate
          &ldquo;last day&rdquo; option — it would store 31 as well, and nothing could tell the two apart.
        </p>
        {day == null && row.billingType !== "per_match" && (
          <div className="mt-2 rounded-md border border-[#f2cdc8] bg-[#fdeceb] px-2.5 py-2 text-[12px] font-bold leading-relaxed text-[#a8321f]">
            Without a day the {fmtMoney(row.amount)} still counts in {monthFull(month)}&rsquo;s total
            — it just lands on no day, and OpEx files it under &ldquo;Undated — timing not set&rdquo;.
            Cash Flow is unaffected; it never reads the billing day.
          </div>
        )}
      </div>

      {/* ── PLAYER PRICING · NOT A COST ────────────────────────────────────────────────────── */}
      <div className="p-4">
        <div className={glab}>Player pricing · not a cost</div>
        {/* EDITABLE, because the write lands: fin_venues UPDATE from the browser affects the row
            (unlike app_users, where RLS made the same shape a silent no-op). */}
        <div className={fld}>
          <label className={lab}>DPP price</label>
          <PriceCell stored={venue?.dpp_price ?? null} state={cellState("dpp_price")}
            onSave={(raw) => onSavePrice("dpp_price", raw)} />
        </div>
        <div className={fld}>
          <label className={lab}>Member price</label>
          <PriceCell stored={venue?.member_price ?? null} state={cellState("member_price")}
            onSave={(raw) => onSavePrice("member_price", raw)} />
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-deep-green/45">
          What a player pays to join a match here. Changing it changes <b className="text-deep-green/70">revenue</b>,
          not field cost.
        </p>
      </div>
    </div>
  );
}

function ordinalDay(d: number): string {
  const s = ["th", "st", "nd", "rd"][(d % 100 - 20) % 10] ?? ["th", "st", "nd", "rd"][d % 100] ?? "th";
  return `${d}${s}`;
}


// Click-to-toggle Yes/No pill for fin_venues.charge_on_cancel. Same
// optimistic save + flash/error pattern as BillingTypeCell — drives
// straight into saveVenueField via the onSave prop. Yes = mint
// highlight (positive, matches the "active" affordance used by the
// As Billed / Per-Match toggle), No = cream-soft.

const CADENCE_OPTIONS: FinVenue["billing_cadence"][] = [
  "monthly",
  "quarterly",
  "annual",
  "weekly",
  "custom",
];
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Q2Month ("Jul 2026") → ISO year-month ("2026-07"), the key format
// fin_venues.billing_custom_days uses.
function monthToIso(month: string): string | null {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(month.trim());
  if (!m) return null;
  const idx = MONTH_ABBR.indexOf(m[1]);
  if (idx < 0) return null;
  return `${m[2]}-${String(idx + 1).padStart(2, "0")}`;
}

// Billing-timing editor for the OpEx calendar (migrations 0069 + 0070).
// Editing here writes fin_venues.billing_* (and, for CUSTOM amounts, the
// per-month override) via the same optimistic path as the price cells; it
// never changes any cost total, only WHEN the money lands in OpEx.
//
// Cadences and the controls they reveal:
//   monthly/quarterly/annual → billing_day (+ anchor month) single lump.
//   weekly                   → billing_weekday; the month splits across it.
//   custom                   → this month's day(s), captured month by month
//                              in billing_custom_days. For a flat venue the
//                              AMOUNT input writes the per-month override
//                              (single source of truth); per-match custom
//                              keeps its auto matches × rate amount.
//
// Flat / profit_share and dashboard-driven per_match (Crossbar) always need
// a hit-date. Schedule-dated per_match venues default to "per match · auto"
// (each match dated on its day); picking a cadence switches them off auto.
const parseCustomDays = (raw: string): number[] =>
  [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
    ),
  ].sort((a, b) => a - b);

function BillingTimingCell({
  venue,
  dashboardDriven,
  isCombinedPrimary,
  month,
  autoAmount,
  monthOverride,
  cadenceState,
  dayState,
  anchorState,
  weekdayState,
  customDaysState,
  customAmountState,
  onSaveCadence,
  onSaveDay,
  onSaveAnchorMonth,
  onSaveWeekday,
  onSaveCustomDays,
  onSaveCustomAmount,
}: {
  venue: FinVenue | null;
  dashboardDriven: boolean;
  isCombinedPrimary: boolean;
  month: Q2Month;
  autoAmount: number;
  monthOverride: FinVenueCostOverride | null;
  cadenceState: CellState | null;
  dayState: CellState | null;
  anchorState: CellState | null;
  weekdayState: CellState | null;
  customDaysState: CellState | null;
  customAmountState: CellState | null;
  onSaveCadence: (next: FinVenue["billing_cadence"]) => void;
  onSaveDay: (raw: string) => void;
  onSaveAnchorMonth: (raw: string) => void;
  onSaveWeekday: (raw: string) => void;
  onSaveCustomDays: (monthIso: string, days: number[]) => void;
  onSaveCustomAmount: (raw: string) => void;
}) {
  const iso = monthToIso(month);
  const storedDays = (iso && venue?.billing_custom_days?.[iso]) || [];
  const storedDaysStr = storedDays.join(", ");
  const storedAmt = monthOverride ? String(monthOverride.override_amount) : "";

  const [day, setDay] = useState(
    venue?.billing_day == null ? "" : String(venue.billing_day),
  );
  const [daysInput, setDaysInput] = useState(storedDaysStr);
  const [amtInput, setAmtInput] = useState(storedAmt);

  // Resync each input from its stored value when idle, and also on error so
  // a failed save visibly reverts (the optimistic patch rolled it back).
  useEffect(() => {
    if (!dayState || dayState.error) {
      setDay(venue?.billing_day == null ? "" : String(venue.billing_day));
    }
  }, [venue?.billing_day, dayState]);
  useEffect(() => {
    if (!customDaysState || customDaysState.error) setDaysInput(storedDaysStr);
  }, [storedDaysStr, customDaysState]);
  useEffect(() => {
    if (!customAmountState || customAmountState.error) setAmtInput(storedAmt);
  }, [storedAmt, customAmountState]);

  if (!venue) return null;

  // Schedule-dated per_match venues (not Crossbar-style dashboard payouts)
  // get an "auto" mode: cadence monthly + billing_day null → dated on match
  // days. Any explicit cadence takes over. weekly/custom don't use
  // billing_day, so mode follows the cadence directly for them.
  const isSchedulePerMatch =
    venue.billing_type === "per_match" && !dashboardDriven;
  const cadence = venue.billing_cadence ?? "monthly";
  const mode: "auto" | FinVenue["billing_cadence"] =
    isSchedulePerMatch && cadence === "monthly" && venue.billing_day == null
      ? "auto"
      : cadence;

  const anySaving = Boolean(
    cadenceState?.saving ||
      dayState?.saving ||
      anchorState?.saving ||
      weekdayState?.saving ||
      customDaysState?.saving ||
      customAmountState?.saving,
  );
  const anyError =
    cadenceState?.error ||
    dayState?.error ||
    anchorState?.error ||
    weekdayState?.error ||
    customDaysState?.error ||
    customAmountState?.error;
  const showDay = mode === "monthly" || mode === "quarterly" || mode === "annual";
  const showAnchor = mode === "quarterly" || mode === "annual";
  const showWeekday = mode === "weekly";
  const showCustom = mode === "custom";
  // Every billing type now takes a per-month amount override in the custom
  // cell. per_match venues show the auto matches × rate as the baseline
  // (placeholder + "auto: $X"); a typed value creates the override. flat /
  // profit_share have no meaningful auto, so the amount IS the cost.
  const hasAuto = venue.billing_type === "per_match";
  const isOverridden = monthOverride != null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <select
          value={mode}
          disabled={anySaving}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "auto") {
              // Back to schedule-dated: monthly cadence, no billing day.
              if (cadence !== "monthly") onSaveCadence("monthly");
              if (venue.billing_day != null) onSaveDay("");
              return;
            }
            const nextCadence = next as FinVenue["billing_cadence"];
            if (nextCadence !== cadence) onSaveCadence(nextCadence);
            // A schedule per-match venue's "auto" state IS cadence monthly +
            // billing_day null. Picking "monthly" leaves cadence unchanged,
            // so seed a billing_day or mode snaps back to "auto" and the day
            // box never appears. weekly/custom/quarterly/annual leave auto
            // via the cadence change itself, so no seed.
            if (
              isSchedulePerMatch &&
              nextCadence === "monthly" &&
              venue.billing_day == null
            ) {
              onSaveDay("1");
            }
          }}
          className="rounded-md border border-cream-line bg-cream-soft px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60"
        >
          {isSchedulePerMatch && (
            <option value="auto">per match · auto</option>
          )}
          {CADENCE_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {showDay && (
          <>
            <span className="text-[10px] text-deep-green/45">day</span>
            <input
              type="number"
              min="1"
              max="31"
              value={day}
              placeholder="—"
              disabled={anySaving}
              onChange={(e) => setDay(e.target.value)}
              onBlur={() => {
                const cur = venue.billing_day == null ? "" : String(venue.billing_day);
                if (day !== cur) onSaveDay(day);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                else if (e.key === "Escape") {
                  setDay(venue.billing_day == null ? "" : String(venue.billing_day));
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              className="w-12 rounded-md border border-cream-line bg-cream-soft px-1.5 py-1 text-right font-mono text-[11px] tabular-nums text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60"
            />
          </>
        )}
        {showWeekday && (
          <>
            <span className="text-[10px] text-deep-green/45">on</span>
            <select
              value={venue.billing_weekday ?? ""}
              disabled={anySaving}
              onChange={(e) => onSaveWeekday(e.target.value)}
              className="rounded-md border border-cream-line bg-cream-soft px-1.5 py-1 font-mono text-[10px] text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60"
            >
              <option value="">— day —</option>
              {WEEKDAY_ABBR.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {showAnchor && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-deep-green/45">
            {mode === "quarterly" ? "every 3mo from" : "in"}
          </span>
          <select
            value={venue.billing_anchor_month ?? ""}
            disabled={anySaving}
            onChange={(e) => onSaveAnchorMonth(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-1.5 py-1 font-mono text-[10px] text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60"
          >
            <option value="">— month —</option>
            {MONTH_ABBR.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}
      {showCustom && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-deep-green/55">
            {month}
          </span>
          <span className="text-[10px] text-deep-green/45">day(s)</span>
          <input
            value={daysInput}
            placeholder="—"
            disabled={anySaving || !iso}
            onChange={(e) => setDaysInput(e.target.value)}
            onBlur={() => {
              if (!iso) return;
              const days = parseCustomDays(daysInput);
              if (days.join(",") !== storedDays.join(",")) onSaveCustomDays(iso, days);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setDaysInput(storedDaysStr);
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="w-16 rounded-md border border-cream-line bg-cream-soft px-1.5 py-1 text-right font-mono text-[11px] tabular-nums text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60"
          />
          <span className="text-[10px] text-deep-green/45">$</span>
          <input
            value={amtInput}
            // per_match shows the auto matches × rate as ghost text; a typed
            // value creates the override for this month.
            placeholder={hasAuto ? String(Math.round(autoAmount)) : "—"}
            disabled={anySaving}
            onChange={(e) => setAmtInput(e.target.value)}
            onBlur={() => {
              if (amtInput.trim() !== storedAmt) onSaveCustomAmount(amtInput);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setAmtInput(storedAmt);
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className={`w-20 rounded-md border bg-cream-soft px-1.5 py-1 text-right font-mono text-[11px] tabular-nums text-deep-green focus:border-deep-green focus:outline-none disabled:opacity-60 ${
              isOverridden ? "border-mint-hover ring-1 ring-mint/50" : "border-cream-line"
            }`}
          />
          {isOverridden && (
            <>
              <span className="inline-flex items-center gap-0.5 rounded-full bg-mint px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-deep-green">
                <Pin size={9} aria-hidden />
                set
              </span>
              <button
                type="button"
                disabled={anySaving}
                onClick={() => onSaveCustomAmount("")}
                className="text-[9px] font-semibold text-coral/80 underline underline-offset-2 hover:text-coral disabled:opacity-60"
              >
                clear → auto
              </button>
            </>
          )}
        </div>
      )}
      {showCustom && hasAuto && !anySaving && (
        <span className="text-[9px] text-deep-green/45">
          auto: {fmtMoney(autoAmount, true)}
          {isOverridden ? " · overridden" : ""}
        </span>
      )}
      {/* Combined-primary override covers this leg only; secondaries bill
          their own cost unless explicitly $0-overridden. */}
      {showCustom && isCombinedPrimary && !anySaving && (
        <span className="text-[9px] font-semibold text-[#9a6a00]">
          secondary legs still bill their own cost — enter $0 on a leg if this
          invoice covers it
        </span>
      )}
      {/* per_match caveat, surfaced (not silent): quarterly/annual only
          dates the billing-month total; off-cycle months land undated */}
      {isSchedulePerMatch && showAnchor && venue.billing_day != null && !anySaving && (
        <span className="text-[9px] font-semibold text-[#9a6a00]">
          off-cycle months land undated
        </span>
      )}
      {/* flat / dashboard venue with no date → undated (no auto fallback) */}
      {!isSchedulePerMatch && showDay && venue.billing_day == null && !anySaving && (
        <span className="text-[9px] font-semibold text-coral/80">
          no date → undated in OpEx
        </span>
      )}
      {showAnchor && venue.billing_anchor_month == null && !anySaving && (
        <span className="text-[9px] font-semibold text-coral/80">
          set anchor month
        </span>
      )}
      {showWeekday && venue.billing_weekday == null && !anySaving && (
        <span className="text-[9px] font-semibold text-coral/80">
          pick a weekday → undated
        </span>
      )}
      {/* custom per-month hints (this is a month-scoped entry). A month
          "has a cost" if it's overridden or the per-match auto is non-zero. */}
      {showCustom && !anySaving && (() => {
        const hasDay = storedDays.length > 0;
        const hasAmt = isOverridden || (hasAuto && autoAmount > 0.005);
        if (!hasDay && !hasAmt)
          return (
            <span className="text-[9px] italic text-deep-green/45">
              no payment this month
            </span>
          );
        if (!hasDay && hasAmt)
          return (
            <span className="text-[9px] font-semibold text-coral/80">
              no day → undated in OpEx
            </span>
          );
        if (hasDay && !hasAmt && !hasAuto)
          return (
            <span className="text-[9px] font-semibold text-coral/80">
              set an amount for {month}
            </span>
          );
        return null;
      })()}
      {anyError && <span className="text-[9px] text-coral">! {anyError}</span>}
    </div>
  );
}

function PriceCell({
  stored,
  state,
  onSave,
  placeholder = "—",
  emptyOk = false,
}: {
  stored: number | null;
  state: CellState | null;
  onSave: (raw: string) => void;
  // What an empty box shows when empty is a legitimate state — for the month field that is the
  // figure it WOULD compute, so the box says what leaving it alone gets you.
  placeholder?: string;
  // Suppresses the coral "you have not filled this in" ring. Empty is not a gap on the month
  // field; it is the normal state that means "use the computed figure".
  emptyOk?: boolean;
}) {
  const [local, setLocal] = useState<string>(stored == null ? "" : String(stored));

  // Resync local input from the stored value when idle, and also on error
  // so a failed save visibly reverts the cell (the optimistic patch already
  // rolled the stored value back).
  useEffect(() => {
    if (!state || state.error) {
      setLocal(stored == null ? "" : String(stored));
    }
  }, [stored, state]);

  const isEmpty = stored == null && !state && !emptyOk;
  const showFlash = state?.flash;
  const showError = Boolean(state?.error);
  const showSaving = Boolean(state?.saving);

  return (
    <div
      className={`relative inline-flex w-24 items-center rounded-md ${
        showError
          ? "ring-2 ring-coral"
          : isEmpty
            ? "ring-1 ring-coral/40"
            : "ring-1 ring-cream-line"
      } ${showFlash ? "flash-mint" : ""}`}
      title={state?.error ?? ""}
    >
      <span className="pl-2 pr-0.5 text-xs text-deep-green/50">$</span>
      <input
        type="number"
        min="0"
        step="0.01"
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const cur = stored == null ? "" : String(stored);
          if (local !== cur) onSave(local);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setLocal(stored == null ? "" : String(stored));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={showSaving}
        className="w-full bg-transparent py-1.5 pr-6 text-right font-mono text-xs tabular-nums text-deep-green placeholder:text-[10px] placeholder:font-bold placeholder:text-deep-green/35 focus:outline-none disabled:opacity-60"
      />
      {showSaving && (
        <span className="absolute right-2 top-1/2 inline-block h-2 w-2 -translate-y-1/2 animate-pulse rounded-full bg-deep-green/50" />
      )}
      {showError && !showSaving && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-coral">
          !
        </span>
      )}
    </div>
  );
}

// One row per actual match for this venue/month, straight from
// mdapi_matches (data.masterSchedule = alive, data.cancelledSchedule =
// cancelled). Built per leg by resolved venue_id so split-rate venues
// (ATH Katy) attribute to the right leg + rate. Cancelled matches are
// included only when that leg's venue charges on cancel — so the rows
// sum exactly to the calc total.
type MatchLineItem = {
  date: string;
  venue: string;
  rate: number;
  cancelled: boolean;
};

function buildMatchLineItems(
  data: FinanceData,
  row: FieldCostRow,
  month: Q2Month,
): MatchLineItem[] {
  const items: MatchLineItem[] = [];
  for (const leg of row.legs) {
    const label = leg.rawVenueName || leg.venueName;
    for (const s of data.masterSchedule) {
      if (isEventSchedule(s)) continue;
      if (s.venue_id === leg.venueId && s.month === month) {
        items.push({ date: s.match_date, venue: label, rate: leg.rate, cancelled: false });
      }
    }
    const venue = data.venues.find((v) => v.id === leg.venueId);
    if (venue?.charge_on_cancel) {
      for (const s of data.cancelledSchedule) {
        if (isEventSchedule(s)) continue;
        if (s.venue_id === leg.venueId && s.month === month) {
          items.push({ date: s.match_date, venue: label, rate: leg.rate, cancelled: true });
        }
      }
    }
  }
  return items;
}

function PerMatchExpand({
  scheduleRows,
}: {
  row: FieldCostRow;
  scheduleRows: MatchLineItem[];
}) {
  if (scheduleRows.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        No matches for this month.
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        Underlying matches · from MatchDay
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          <tr>
            <th className="py-1 text-left">Date</th>
            <th className="py-1 text-left">Leg</th>
            <th className="py-1 text-left">Status</th>
            <th className="py-1 text-right">Rate</th>
            <th className="py-1 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {[...scheduleRows]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((s, i) => (
              <tr key={i} className="border-t border-cream-line/40">
                <td className="py-1 pr-3 text-deep-green">{s.date}</td>
                <td className="py-1 pr-3 text-deep-green/65">{s.venue}</td>
                <td
                  className={`py-1 pr-3 ${s.cancelled ? "text-[#9a6a00]" : "text-deep-green/45"}`}
                >
                  {s.cancelled ? "cancelled, charged" : "ran"}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-deep-green/55">
                  ${s.rate}
                </td>
                <td className="py-1 text-right font-bold tabular-nums text-deep-green">
                  {fmtMoney(s.rate, true)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
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
