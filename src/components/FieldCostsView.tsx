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
import FieldCostOverrideEditor, {
  type OverrideDraft,
} from "@/components/FieldCostOverrideEditor";
import { logChange } from "@/lib/financeAudit";
import {
  buildFieldCostRows,
  fieldCostsFor,
  overrideOnlyTotalFor,
  perMatchTotalFor,
  totalOverrideAmountFor,
  type FieldCostRow,
} from "@/lib/financeCosts";
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
  type FinVenue,
  type FinVenueCostOverride,
} from "@/lib/useFinanceData";

type PriceField = "dpp_price" | "member_price" | "cost_per_match";
type EditableField = PriceField | "billing_type" | "charge_on_cancel";
type CellState = { saving: boolean; error: string | null; flash: boolean };
type EditMap = Map<string, CellState>;
function editKey(venueId: number, field: EditableField): string {
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

export default function FieldCostsView({
  // Optional handoff: when set, the post-save banner's "Add it to
  // Billing Schedule" button calls this with the new venue's id.
  // Page wires it to switch the tab + drop a sessionStorage hint
  // BillingScheduleView reads on mount to open its add editor
  // prefilled with this venue.
  onAddedVenueGotoSchedule,
}: {
  onAddedVenueGotoSchedule?: (venueId: number) => void;
} = {}) {
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

  const [overrideEditorOpen, setOverrideEditorOpen] = useState(false);
  const [overrideEditorRow, setOverrideEditorRow] = useState<FieldCostRow | null>(null);

  const [removeRow, setRemoveRow] = useState<FieldCostRow | null>(null);

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
    nextValue: number | string | boolean | null,
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
    setEditState(key, { saving: true, error: null, flash: false });
    const before: Record<string, unknown> = {
      id: venue.id,
      [field]: venue[field],
    };
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
      await refetchFinanceData();
      setEditState(key, { saving: false, error: null, flash: true });
      // Clear flash + state after the animation settles.
      setTimeout(() => setEditState(key, null), 900);
    } catch (e) {
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

  function openSetOverride(row: FieldCostRow) {
    setOverrideEditorRow(row);
    setOverrideEditorOpen(true);
  }

  async function handleSubmitOverride(draft: OverrideDraft) {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");
    if (!overrideEditorRow) return;
    const row = overrideEditorRow;
    const before = row.override;

    if (before) {
      const updates = {
        month: draft.month,
        override_amount: draft.override_amount,
        reason: draft.reason || null,
      };
      const { data: updated, error } = await supabase
        .from("fin_venue_cost_overrides")
        .update(updates)
        .eq("id", before.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_venue_cost_overrides",
        rowId: before.id,
        action: "update",
        changedBy: email,
        before: before as unknown as Record<string, unknown>,
        after: updated as Record<string, unknown>,
      });
    } else {
      const payload = {
        venue_id: row.primaryVenueId,
        month: draft.month,
        override_amount: draft.override_amount,
        reason: draft.reason || null,
        created_by: email,
      };
      const { data: inserted, error } = await supabase
        .from("fin_venue_cost_overrides")
        .insert(payload)
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
    }

    // ATH Katy combine: ensure secondary venues have a $0 override for the
    // same month so company-wide aggregations don't double-count the auto
    // legs alongside the primary's combined override.
    for (const sid of row.secondaryVenueIds) {
      const existing = data?.overrides.find(
        (o) => o.venue_id === sid && o.month === draft.month,
      );
      if (existing) {
        if (existing.override_amount !== 0) {
          const sBefore = existing;
          const { data: sUpdated, error: sErr } = await supabase
            .from("fin_venue_cost_overrides")
            .update({
              override_amount: 0,
              reason: "Combined into primary override",
            })
            .eq("id", existing.id)
            .select()
            .single();
          if (sErr) throw new Error(sErr.message);
          await logChange({
            tableName: "fin_venue_cost_overrides",
            rowId: existing.id,
            action: "update",
            changedBy: email,
            before: sBefore as unknown as Record<string, unknown>,
            after: sUpdated as Record<string, unknown>,
          });
        }
      } else {
        const sPayload = {
          venue_id: sid,
          month: draft.month,
          override_amount: 0,
          reason: "Combined into primary override",
          created_by: email,
        };
        const { data: sInserted, error: sErr } = await supabase
          .from("fin_venue_cost_overrides")
          .insert(sPayload)
          .select()
          .single();
        if (sErr) throw new Error(sErr.message);
        await logChange({
          tableName: "fin_venue_cost_overrides",
          rowId: (sInserted as { id: number }).id,
          action: "insert",
          changedBy: email,
          after: sInserted as Record<string, unknown>,
        });
      }
    }

    await refetchFinanceData();
    setOverrideEditorOpen(false);
    setOverrideEditorRow(null);
  }

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

  async function handleRemoveOverride() {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");
    if (!removeRow || !removeRow.override) return;
    const row = removeRow;
    const primaryOverride = row.override!;

    await logChange({
      tableName: "fin_venue_cost_overrides",
      rowId: primaryOverride.id,
      action: "delete",
      changedBy: email,
      before: primaryOverride as unknown as Record<string, unknown>,
    });
    const { error } = await supabase
      .from("fin_venue_cost_overrides")
      .delete()
      .eq("id", primaryOverride.id);
    if (error) throw new Error(error.message);

    for (const sid of row.secondaryVenueIds) {
      const sec: FinVenueCostOverride | undefined = data?.overrides.find(
        (o) => o.venue_id === sid && o.month === primaryOverride.month,
      );
      if (sec) {
        await logChange({
          tableName: "fin_venue_cost_overrides",
          rowId: sec.id,
          action: "delete",
          changedBy: email,
          before: sec as unknown as Record<string, unknown>,
        });
        const { error: sErr } = await supabase
          .from("fin_venue_cost_overrides")
          .delete()
          .eq("id", sec.id);
        if (sErr) throw new Error(sErr.message);
      }
    }

    await refetchFinanceData();
    setRemoveRow(null);
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

      <div className="mb-6">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Field Costs
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          Single source of truth for venue costs. Per-match billing
          auto-computes from the schedule; monthly_flat and profit_share
          venues read from per-month overrides — set them with the
          row-level Override button. Cash Flow&apos;s Field Costs line sums
          all of this.
        </p>
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
            <option value="OVERRIDE">Override</option>
          </select>
        </Filter>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-deep-green/75">
          <input
            type="checkbox"
            checked={hasOverrideOnly}
            onChange={(e) => setHasOverrideOnly(e.target.checked)}
          />
          Has override only
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
            {onAddedVenueGotoSchedule && (
              <button
                type="button"
                onClick={() => onAddedVenueGotoSchedule(lastAdded.venueId)}
                className="rounded-full bg-deep-green px-4 py-1.5 text-xs font-bold text-cream transition hover:bg-deep-green/85"
              >
                Add it to Billing Schedule →
              </button>
            )}
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

      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr className="border-b border-cream-line">
                <th className="w-8 px-3 py-2"></th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-left">City</th>
                <th className="px-3 py-2 text-left">Billing</th>
                <th className="px-3 py-2 text-right">DPP Price</th>
                <th className="px-3 py-2 text-right">Member Price</th>
                <th className="px-3 py-2 text-right">Cost/Match</th>
                <th className="px-3 py-2 text-center">Pay on Cancel</th>
                <th className="px-3 py-2 text-right">Match Count</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-left">How it's computed</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {loading && filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={12}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading field costs…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={12}
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
                      onSetOverride={() => openSetOverride(row)}
                      onRemoveOverride={() => setRemoveRow(row)}
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
                      scheduleRows={
                        data
                          ? data.schedule.filter(
                              (s) =>
                                s.month === month &&
                                row.legs.some(
                                  (l) =>
                                    l.rawVenueName === s.venue_raw ||
                                    l.venueName === s.venue,
                                ),
                            )
                          : []
                      }
                    />
                  );
                })
              )}
            </tbody>
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
                <span>Manual overrides ({month}):</span>
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

      <FieldCostOverrideEditor
        open={overrideEditorOpen}
        row={overrideEditorRow}
        initialMonth={month}
        onClose={() => {
          setOverrideEditorOpen(false);
          setOverrideEditorRow(null);
        }}
        onSubmit={handleSubmitOverride}
      />

      <AddVenueDialog
        open={addVenueOpen}
        onClose={() => setAddVenueOpen(false)}
        onSubmit={handleSubmitAddVenue}
      />

      <ConfirmDeleteDialog
        open={Boolean(removeRow)}
        title="Remove override?"
        confirmLabel="Remove Override"
        summary={
          removeRow ? (
            <div className="space-y-1 text-xs">
              <div className="font-mono">
                {removeRow.displayName} · {removeRow.override?.month}
              </div>
              <div>
                Cost will revert to auto-compute (
                <span className="font-mono">
                  {fmtMoney(removeRow.autoAmount, true)}
                </span>
                ).
              </div>
              {removeRow.override?.reason && (
                <div className="text-deep-green/55">
                  Reason on file: {removeRow.override.reason}
                </div>
              )}
            </div>
          ) : null
        }
        onCancel={() => setRemoveRow(null)}
        onConfirm={handleRemoveOverride}
      />

    </>
  );
}

function FieldCostTableRow({
  row,
  expanded,
  expandable,
  onToggleExpand,
  onSetOverride,
  onRemoveOverride,
  primaryVenue,
  cellState,
  onSavePrice,
  onSaveBillingType,
  onSaveChargeOnCancel,
  scheduleRows,
  highlight,
}: {
  row: FieldCostRow;
  expanded: boolean;
  expandable: boolean;
  onToggleExpand: () => void;
  onSetOverride: () => void;
  onRemoveOverride: () => void;
  primaryVenue: FinVenue | null;
  cellState: (field: EditableField) => CellState | null;
  onSavePrice: (field: PriceField, raw: string) => void;
  onSaveBillingType: (next: FinVenue["billing_type"]) => void;
  onSaveChargeOnCancel: (next: boolean) => void;
  scheduleRows: {
    date: string;
    venue: string;
    venue_raw: string;
    match_count: number;
  }[];
  // Set briefly when the Match P&L tab links back to this row.
  // Renders a soft mint pulse so the operator can find the row.
  highlight?: boolean;
}) {
  const isOverride = Boolean(row.override);
  const isCombined = row.secondaryVenueIds.length > 0;
  return (
    <>
      <tr
        id={`venue-row-${row.primaryVenueId}`}
        className={`group border-t border-cream-line/40 ${
          expandable ? "cursor-pointer" : ""
        } hover:bg-cream-soft/50 ${highlight ? "animate-pulse bg-mint-soft" : ""}`}
        onClick={expandable ? onToggleExpand : undefined}
      >
        <td className="px-3 py-2 text-deep-green/55">
          {expandable ? (
            expanded ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )
          ) : null}
        </td>
        <td className="px-3 py-2 font-semibold text-deep-green">
          {row.displayName}
          {isCombined && (
            <span className="ml-1 text-[10px] font-normal text-deep-green/45">
              (combined)
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-deep-green/85">{row.city}</td>
        <td
          className="px-3 py-2"
          onClick={(e) => e.stopPropagation()}
        >
          <BillingTypeCell
            stored={primaryVenue?.billing_type ?? null}
            combined={isCombined}
            state={cellState("billing_type")}
            onSave={onSaveBillingType}
          />
        </td>
        <td
          className="px-3 py-2 text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <PriceCell
            stored={primaryVenue?.dpp_price ?? null}
            state={cellState("dpp_price")}
            onSave={(raw) => onSavePrice("dpp_price", raw)}
          />
        </td>
        <td
          className="px-3 py-2 text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <PriceCell
            stored={primaryVenue?.member_price ?? null}
            state={cellState("member_price")}
            onSave={(raw) => onSavePrice("member_price", raw)}
          />
        </td>
        <td
          className="px-3 py-2 text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <PriceCell
            stored={primaryVenue?.cost_per_match ?? null}
            state={cellState("cost_per_match")}
            onSave={(raw) => onSavePrice("cost_per_match", raw)}
          />
        </td>
        <td
          className="px-3 py-2 text-center"
          onClick={(e) => e.stopPropagation()}
        >
          <ChargeOnCancelCell
            stored={primaryVenue?.charge_on_cancel ?? true}
            state={cellState("charge_on_cancel")}
            onSave={onSaveChargeOnCancel}
          />
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/75">
          {row.matchCount}
        </td>
        <td className="px-3 py-2 text-right">
          <span
            className={`inline-flex items-center gap-1 font-mono font-bold tabular-nums ${
              isOverride ? "text-deep-green" : "text-deep-green"
            }`}
          >
            {isOverride && (
              <span title="Override active" className="inline-flex">
                <Pin
                  size={11}
                  aria-hidden
                  className="text-mint-hover"
                />
              </span>
            )}
            {fmtMoney(row.amount, true)}
            {!isOverride && row.billingType === "per_match" && (
              <Lock
                size={10}
                aria-hidden
                className="ml-1 text-deep-green/35"
              />
            )}
          </span>
        </td>
        <td className="px-3 py-2 text-deep-green/85">{row.formula}</td>
        <td className="px-3 py-2 text-deep-green/55">{row.source}</td>
        <td
          className="px-3 py-2 text-right"
          onClick={(e) => e.stopPropagation()}
        >
          {isOverride ? (
            <div className="inline-flex items-center gap-1 opacity-100 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={onSetOverride}
                className="inline-flex items-center gap-1 rounded-full border border-cream-line bg-cream-soft px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green hover:bg-cream"
                aria-label="Edit override"
              >
                <Pencil size={10} aria-hidden />
                Edit
              </button>
              <button
                type="button"
                onClick={onRemoveOverride}
                className="inline-flex items-center gap-1 rounded-full border border-coral/30 bg-coral-soft/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-coral hover:bg-coral-soft/60"
                aria-label="Remove override"
              >
                <Trash2 size={10} aria-hidden />
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSetOverride}
              className="rounded-full border border-cream-line bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/65 hover:bg-cream-soft hover:text-deep-green"
            >
              Set Override
            </button>
          )}
        </td>
      </tr>
      {expanded && expandable && (
        <tr className="bg-cream-soft/40">
          <td colSpan={12} className="px-5 py-3">
            <PerMatchExpand row={row} scheduleRows={scheduleRows} />
          </td>
        </tr>
      )}
    </>
  );
}

function BillingTypeCell({
  stored,
  combined,
  state,
  onSave,
}: {
  stored: FinVenue["billing_type"] | null;
  combined: boolean;
  state: CellState | null;
  onSave: (next: FinVenue["billing_type"]) => void;
}) {
  const showFlash = state?.flash;
  const showError = Boolean(state?.error);
  const showSaving = Boolean(state?.saving);

  if (combined) {
    return (
      <span
        title="Combined groups (e.g. ATH Katy + ATH Katy Sunday) edit billing on individual venue rows."
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-deep-green/65"
      >
        {(stored ?? "—").toUpperCase()}
        <span className="font-normal normal-case text-deep-green/40">
          (combined)
        </span>
      </span>
    );
  }

  return (
    <div
      className={`relative inline-flex items-center rounded-md ${
        showError ? "ring-2 ring-coral" : "ring-1 ring-cream-line"
      } ${showFlash ? "flash-mint" : ""}`}
      title={state?.error ?? ""}
    >
      <select
        value={stored ?? ""}
        disabled={showSaving}
        onChange={(e) => {
          const next = e.target.value as FinVenue["billing_type"];
          if (next === stored) return;
          onSave(next);
        }}
        className="bg-transparent px-2 py-1.5 pr-7 font-mono text-[10px] uppercase tracking-wider text-deep-green focus:outline-none disabled:opacity-60"
      >
        {stored == null && (
          <option value="" disabled>
            —
          </option>
        )}
        {BILLING_TYPE_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
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

// Click-to-toggle Yes/No pill for fin_venues.charge_on_cancel. Same
// optimistic save + flash/error pattern as BillingTypeCell — drives
// straight into saveVenueField via the onSave prop. Yes = mint
// highlight (positive, matches the "active" affordance used by the
// As Billed / Per-Match toggle), No = cream-soft.
function ChargeOnCancelCell({
  stored,
  state,
  onSave,
}: {
  stored: boolean;
  state: CellState | null;
  onSave: (next: boolean) => void;
}) {
  const showFlash = state?.flash;
  const showError = Boolean(state?.error);
  const showSaving = Boolean(state?.saving);
  return (
    <button
      type="button"
      disabled={showSaving}
      onClick={() => onSave(!stored)}
      title={state?.error ?? "Toggle whether this venue charges for cancelled matches"}
      aria-pressed={stored}
      className={`relative inline-flex items-center rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${
        stored
          ? "bg-mint text-deep-green ring-mint/60"
          : "bg-cream-soft text-deep-green/65 ring-cream-line"
      } ${showError ? "ring-2 ring-coral" : ""} ${
        showFlash ? "flash-mint" : ""
      } disabled:opacity-60`}
    >
      {stored ? "Yes" : "No"}
      {showSaving && (
        <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-deep-green/50" />
      )}
      {showError && !showSaving && (
        <span className="ml-1 text-[10px] font-bold text-coral">!</span>
      )}
    </button>
  );
}

function PriceCell({
  stored,
  state,
  onSave,
}: {
  stored: number | null;
  state: CellState | null;
  onSave: (raw: string) => void;
}) {
  const [local, setLocal] = useState<string>(stored == null ? "" : String(stored));

  // Reset local input when stored value changes (after refetch) and we're
  // not in the middle of an edit.
  useEffect(() => {
    if (!state) {
      setLocal(stored == null ? "" : String(stored));
    }
  }, [stored, state]);

  const isEmpty = stored == null && !state;
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
        placeholder="—"
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
        className="w-full bg-transparent py-1.5 pr-6 text-right font-mono text-xs tabular-nums text-deep-green focus:outline-none disabled:opacity-60"
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

function PerMatchExpand({
  row,
  scheduleRows,
}: {
  row: FieldCostRow;
  scheduleRows: {
    date: string;
    venue: string;
    venue_raw: string;
    match_count: number;
  }[];
}) {
  if (scheduleRows.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        No schedule entries for this month.
      </div>
    );
  }
  // Key rate lookup by raw venue name. For split-rate venues like ATH Katy,
  // both legs share the canonical name post-alias, so canonical-keyed
  // lookups would have one leg overwrite the other. raw_venue_name keeps
  // them distinct.
  const rateByRawVenue = new Map<string, number>();
  for (const leg of row.legs) {
    rateByRawVenue.set(leg.rawVenueName, leg.rate);
  }
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        Underlying schedule entries
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          <tr>
            <th className="py-1 text-left">Date</th>
            <th className="py-1 text-left">Leg</th>
            <th className="py-1 text-right">Matches</th>
            <th className="py-1 text-right">Rate</th>
            <th className="py-1 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {[...scheduleRows]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((s, i) => {
              const rate =
                rateByRawVenue.get(s.venue_raw) ??
                rateByRawVenue.get(s.venue) ??
                0;
              const cost = (s.match_count ?? 0) * rate;
              return (
                <tr key={i} className="border-t border-cream-line/40">
                  <td className="py-1 pr-3 text-deep-green">{s.date}</td>
                  <td className="py-1 pr-3 text-deep-green/65">
                    {s.venue_raw || s.venue}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-deep-green/75">
                    {s.match_count}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-deep-green/55">
                    ${rate}
                  </td>
                  <td className="py-1 text-right font-bold tabular-nums text-deep-green">
                    {fmtMoney(cost, true)}
                  </td>
                </tr>
              );
            })}
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
