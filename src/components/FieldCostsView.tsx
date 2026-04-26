"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Lock, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import FieldCostOverrideEditor, {
  type OverrideDraft,
} from "@/components/FieldCostOverrideEditor";
import OneOffFieldCostEditor, {
  type OneOffDraft,
} from "@/components/OneOffFieldCostEditor";
import { logChange } from "@/lib/financeAudit";
import {
  buildFieldCostRows,
  monthlyFlatTotalFor,
  oneOffFieldCostsFor,
  perMatchTotalFor,
  totalOverrideAmountFor,
  venueRentalLineFor,
  type FieldCostRow,
} from "@/lib/financeCosts";
import { Q2_MONTHS, perMatchVenueCostFor, type Q2Month } from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import {
  refetchFinanceData,
  useFinanceData,
  type FinVenueCostOverride,
} from "@/lib/useFinanceData";

type BillingFilter = "ALL" | "per_match" | "monthly_flat" | "per_hour" | "OVERRIDE";

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

  const [month, setMonth] = useState<Q2Month>("Apr 2026");
  const [cityFilter, setCityFilter] = useState<string>(ALL);
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("ALL");
  const [hasOverrideOnly, setHasOverrideOnly] = useState(false);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const [overrideEditorOpen, setOverrideEditorOpen] = useState(false);
  const [overrideEditorRow, setOverrideEditorRow] = useState<FieldCostRow | null>(null);

  const [removeRow, setRemoveRow] = useState<FieldCostRow | null>(null);

  const [oneOffOpen, setOneOffOpen] = useState(false);

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

  // Reconciliation totals (always month-level, ignoring city/billing filters
  // so the banner compares apples to apples with Cash Flow / hero metrics).
  const recon = useMemo(() => {
    if (!data) return null;
    const fieldTotal = allRows.reduce((s, r) => s + r.amount, 0);
    const cashFlowTotal =
      perMatchVenueCostFor(data, month) + venueRentalLineFor(data, month);
    const filteredTotal = filtered.reduce((s, r) => s + r.amount, 0);
    const perMatch = perMatchTotalFor(data, month);
    const monthlyFlat = monthlyFlatTotalFor(data, month);
    const overrideInfo = totalOverrideAmountFor(data, month);
    const oneOff = oneOffFieldCostsFor(data, month);
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
      monthlyFlat,
      overrideInfo,
      oneOff,
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

  async function handleOneOffSubmit(draft: OneOffDraft) {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");
    const payload = {
      date: draft.date,
      month: draft.month,
      city: draft.city,
      category: draft.category,
      vendor: draft.vendor || null,
      amount: draft.amount,
      notes: draft.notes || null,
      manual_entry: true,
    };
    const { data: inserted, error } = await supabase
      .from("fin_expenses")
      .insert(payload)
      .select()
      .single();
    if (error) throw new Error(error.message);
    await logChange({
      tableName: "fin_expenses",
      rowId: (inserted as { id: number }).id,
      action: "insert",
      changedBy: email,
      after: inserted as Record<string, unknown>,
      note: `One-off field cost · ${draft.venue_name}`,
    });
    await refetchFinanceData();
    setOneOffOpen(false);
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
            Field Costs
          </h1>
          <p className="mt-2 text-sm text-deep-green/65">
            Per-venue monthly cost. Auto-computed from billing model · override
            any (venue, month) where the real arrangement differs (lump sums,
            prepayments, profit-share adjustments).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOneOffOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green hover:bg-mint-hover"
        >
          <Plus size={16} aria-hidden />
          Add One-off Field Cost
        </button>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Month">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value as Q2Month)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {Q2_MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}
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
            <option value="per_match">per_match</option>
            <option value="monthly_flat">monthly_flat</option>
            <option value="per_hour">per_hour</option>
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
      </div>

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
                    colSpan={9}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading field costs…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
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
                      scheduleRows={
                        data
                          ? data.schedule.filter(
                              (s) =>
                                s.month === month &&
                                (s.venue === row.displayName ||
                                  row.legs.some(
                                    (l) => l.venueName === s.venue,
                                  )),
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
                Cash Flow venue costs ({month}):{" "}
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
                <span>Monthly flat:</span>
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.monthlyFlat, true)}
                </span>
              </li>
              <li className="flex items-baseline gap-2">
                <span className="text-deep-green/55">•</span>
                <span>Overrides:</span>
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.overrideInfo.amount, true)}
                </span>
                <span className="text-deep-green/55">
                  ({recon.overrideInfo.venueCount} venues)
                </span>
              </li>
              <li className="flex items-baseline gap-2">
                <span className="text-deep-green/55">•</span>
                <span>One-off charges (from fin_expenses):</span>
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtMoney(recon.oneOff, true)}
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

      <OneOffFieldCostEditor
        open={oneOffOpen}
        venues={data?.venues ?? []}
        knownCategories={[
          ...new Set(
            (data?.expenses ?? []).map((e) => e.category).filter(Boolean),
          ),
        ].sort()}
        onClose={() => setOneOffOpen(false)}
        onSubmit={handleOneOffSubmit}
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
  scheduleRows,
}: {
  row: FieldCostRow;
  expanded: boolean;
  expandable: boolean;
  onToggleExpand: () => void;
  onSetOverride: () => void;
  onRemoveOverride: () => void;
  scheduleRows: { date: string; venue: string; match_count: number }[];
}) {
  const isOverride = Boolean(row.override);
  return (
    <>
      <tr
        className={`group border-t border-cream-line/40 ${
          expandable ? "cursor-pointer" : ""
        } hover:bg-cream-soft/50`}
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
          {row.secondaryVenueIds.length > 0 && (
            <span className="ml-1 text-[10px] font-normal text-deep-green/45">
              (combined)
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-deep-green/85">{row.city}</td>
        <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-deep-green/65">
          {row.billingType ?? "—"}
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
          <td colSpan={9} className="px-5 py-3">
            <PerMatchExpand row={row} scheduleRows={scheduleRows} />
          </td>
        </tr>
      )}
    </>
  );
}

function PerMatchExpand({
  row,
  scheduleRows,
}: {
  row: FieldCostRow;
  scheduleRows: { date: string; venue: string; match_count: number }[];
}) {
  if (scheduleRows.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        No schedule entries for this month.
      </div>
    );
  }
  const rateByVenue = new Map<string, number>();
  for (const leg of row.legs) {
    rateByVenue.set(leg.venueName, leg.rate);
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
              const rate = rateByVenue.get(s.venue) ?? 0;
              const cost = (s.match_count ?? 0) * rate;
              return (
                <tr key={i} className="border-t border-cream-line/40">
                  <td className="py-1 pr-3 text-deep-green">{s.date}</td>
                  <td className="py-1 pr-3 text-deep-green/65">{s.venue}</td>
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
