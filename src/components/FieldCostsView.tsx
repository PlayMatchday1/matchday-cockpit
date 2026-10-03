"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import AddVenueDialog, { type AddVenueDraft } from "@/components/AddVenueDialog";
import { insertFinVenue } from "@/lib/venueCreate";
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
import { isSoccerCentralTwoPitch } from "@/lib/soccerCentralTwoPitch";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  ALL_DAYS,
  DAY_CHIP,
  DAY_LONG,
  DAY_SHORT,
  cashDays,
  monthName as venuePayMonthName,
  monthShort as venuePayMonthShort,
  payResultText,
  paysOnText,
  rateForYmd,
  rateLabel,
  type DayRate,
  type PaySchedule,
} from "@/lib/venuePay";
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
//   cost_per_match  = the rate AGREED with the venue. Reference data; Cities reads it.
//   per_match_rate  = what the venue INVOICES per match; the panel's rate box writes this one.
// The panel never writes one from the other. With day-of-week rates (rate_days, 0201) both
// paths price each match by its weekday instead.
type EditableField =
  | "per_match_rate"
  | "rate_days"
  | "billing_type"
  | "charge_on_cancel"
  | "pay_schedule"
  | "notes";
type VenuePatch = Partial<Pick<FinVenue, "per_match_rate" | "rate_days" | "billing_type" | "charge_on_cancel" | "pay_schedule" | "notes">>;
// "custom_amount" is a virtual key for the "This month" box — it writes
// fin_venue_cost_overrides, not a fin_venues column, but shares the same
// saving/error cell-state map.
type CellStateKey = EditableField | "custom_amount" | "fields";
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
function editKey(venueId: number, field: CellStateKey): string {
  return `${venueId}|${field}`;
}

type BillingFilter = "ALL" | "match" | "share";

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

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const openedFirst = useRef(false);



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

  /* ONE WRITE PATH FOR EVERY fin_venues EDIT ON THIS PAGE. The diff IS the request body: only the
   * columns whose value differs from the row on file are sent, and an edit that changes nothing
   * sends nothing. Optimistic, with the captured values put back on failure; one fin_change_log
   * entry per write. No retry. */
  async function saveVenuePatch(venueId: number, patch: VenuePatch, field: EditableField): Promise<void> {
    const email = appUser?.email;
    const venue = venueById.get(venueId);
    if (!email || !venue) return;
    const key = editKey(venueId, field);
    const diff: Record<string, unknown> = {};
    const before: Record<string, unknown> = { id: venue.id };
    for (const [k, v] of Object.entries(patch)) {
      const old = (venue as Record<string, unknown>)[k] ?? null;
      if (JSON.stringify(old) === JSON.stringify(v ?? null)) continue;
      diff[k] = v ?? null;
      before[k] = old;
    }
    if (Object.keys(diff).length === 0) return;
    patchVenueOptimistic(venueId, diff as Partial<FinVenue>);
    setEditState(key, { saving: true, error: null, flash: false });
    try {
      const { data: updated, error } = await supabase
        .from("fin_venues")
        .update(diff)
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
      setEditState(key, null);
    } catch (e) {
      const revert: Record<string, unknown> = {};
      for (const k of Object.keys(diff)) revert[k] = before[k];
      patchVenueOptimistic(venueId, revert as Partial<FinVenue>);
      setEditState(key, {
        saving: false,
        error: `Not saved: ${e instanceof Error ? e.message : String(e)}`,
        flash: false,
      });
    }
  }

  /* THE LINKS A VENUE IS MADE OF — counted and excluded — for the Fields checkboxes. */
  const fieldTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of [...(data?.masterSchedule ?? []), ...(data?.cancelledSchedule ?? [])]) {
      if (r.mdapi_field_id != null && r.field_title && !m.has(r.mdapi_field_id)) {
        m.set(r.mdapi_field_id, r.field_title);
      }
    }
    return m;
  }, [data]);

  function fieldsFor(row: FieldCostRow): { fieldId: number; title: string; on: boolean }[] {
    const ids = new Set(row.legs.map((l) => l.venueId));
    ids.add(row.primaryVenueId);
    const title = (l: { mdapi_field_id: number; field_title_at_link: string }) =>
      fieldTitleById.get(l.mdapi_field_id) ?? (l.field_title_at_link || `field ${l.mdapi_field_id}`);
    return [
      ...(data?.venueFieldLinks ?? []).filter((l) => ids.has(l.fin_venue_id)).map((l) => ({ fieldId: l.mdapi_field_id, title: title(l), on: true })),
      ...(data?.excludedFieldLinks ?? []).filter((l) => ids.has(l.fin_venue_id)).map((l) => ({ fieldId: l.mdapi_field_id, title: title(l), on: false })),
    ].sort((a, b) => a.fieldId - b.fieldId);
  }

  /* A FIELD CHECKBOX GOES THROUGH /api/admin/fields/exclude — the only write path for
   * excluded_from_venue, which records the verdict from its read-back. Unchecked = the field stays
   * linked and leaves this venue's matches, spots, revenue and cost. The data is re-read on
   * LANDED: the flag is upstream of every figure on the page. No retry. */
  async function saveFieldCounted(venueId: number, fieldId: number, counted: boolean): Promise<void> {
    const key = editKey(venueId, "fields");
    setEditState(key, { saving: true, error: null, flash: false });
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const res = await fetch("/api/admin/fields/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fieldId, excluded: !counted }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.verdict !== "LANDED") throw new Error(`${j.verdict} — refresh and check before clicking again.`);
      setEditState(key, null);
      await refetchFinanceData();
    } catch (e) {
      setEditState(key, { saving: false, error: `Field not saved: ${e instanceof Error ? e.message : String(e)}`, flash: false });
    }
  }

  /** The first error any write for this venue left behind, for the panel to show. */
  const errorFor = (venueId: number): string | null => {
    for (const [k, st] of edits) if (k.startsWith(`${venueId}|`) && st.error) return st.error;
    return null;
  };

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
      // RESET IS OPTIMISTIC, like every venue edit: the row reads auto at once, and the hand-set
      // amount is put back if the delete fails.
      patchOverrideOptimistic({ type: "remove", venueId, month: forMonth });
      try {
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
      } catch (e) {
        patchOverrideOptimistic({ type: "upsert", row: existing });
        throw e;
      }
      return;
    }
    // The same amount again is not a change, and sends nothing.
    if (existing && Number(existing.override_amount) === amount) return;
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

  const allRows: FieldCostRow[] = useMemo(() => {
    if (!data) return [];
    return buildFieldCostRows(data, month);
  }, [data, month]);

  /* ── SLOT COUNT: THE DISPLAYED MATCH COUNT, AND NOTHING ELSE ─────────────────────────────────
   * Slate Review counts a Soccer Central two-pitch match as 2 — it occupies both 9v9 pitches, so
   * it is two of the slots that page's whole premise is built on. This page showed 1 for the same
   * match, so the two disagreed about how many matches Soccer Central ran.
   *
   * IT IS COMPUTED HERE, IN THE VIEW, ON PURPOSE. financeCosts must never see the two-pitch rule:
   * cost is rate × charged units, the rate already carries the doubling ($180 on fin_venues 53),
   * and a charged unit count of 2 would bill $360. socc-two-pitch-test asserts that file does not
   * import it, and this keeps that true — nothing below computes a cost.
   *
   * THE COST FORMULA IS UNAFFECTED. Soccer Central is a combined group (legs 11 + 53), so its
   * formula line renders `autoFormula`, which financeCosts builds per leg from each leg's own
   * charged count. The number this map produces is read by ONE cell. */
  const slotCountByVenue = useMemo(() => {
    const m = new Map<number, { extra: number; twoPitch: number }>();
    if (!data) return m;
    const add = (s: { venue_id: number | null; mdapi_field_id: number | null; max_spots: number; month: string }) => {
      if (s.month !== month || s.venue_id == null) return;
      if (!isSoccerCentralTwoPitch(s.mdapi_field_id, s.max_spots)) return;
      const e = m.get(s.venue_id) ?? { extra: 0, twoPitch: 0 };
      e.extra += 1; e.twoPitch += 1;      // one EXTRA unit each: 1 charged, 2 counted
      m.set(s.venue_id, e);
    };
    for (const s of data.masterSchedule) add(s);
    for (const s of data.cancelledSchedule) {
      const v = data.venues.find((x) => x.id === s.venue_id);
      if (v?.charge_on_cancel) add(s);    // counted exactly where it is charged
    }
    return m;
  }, [data, month]);

  /* Both legs of a combined group land on the same displayed row, so the extras are summed across
   * every leg the row covers rather than looked up on the primary alone. */
  const slotExtraFor = (row: FieldCostRow): { extra: number; twoPitch: number } =>
    (row.legs ?? []).reduce((acc, l) => {
      const e = slotCountByVenue.get(l.venueId);
      return e ? { extra: acc.extra + e.extra, twoPitch: acc.twoPitch + e.twoPitch } : acc;
    }, { extra: 0, twoPitch: 0 });

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.city);
    return [ALL, ...[...set].sort()];
  }, [allRows]);

  const filtered = useMemo(() => {
    let rows = allRows.slice();
    if (cityFilter !== ALL) rows = rows.filter((r) => r.city === cityFilter);
    if (billingFilter !== "ALL") rows = rows.filter((r) => modelOf(r) === billingFilter);
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [allRows, cityFilter, billingFilter]);

  useEffect(() => {
    if (openedFirst.current || filtered.length === 0) return;
    openedFirst.current = true;
    setExpandedKey(filtered[0].key);
  }, [filtered]);

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
      dpp_price: draft.dpp_price,
      member_price: draft.member_price,
      launch_date: draft.launch_date,
      notes: draft.notes,
      is_active: true,
    };
    // THE INSERT AND ITS DUPLICATE MESSAGE MOVED TO src/lib/venueCreate.ts, because the Field
    // Pipeline board now creates venues too and a second creator is how two paths disagree about
    // what a venue minimally is. Everything below — the mdapi field link and the aliases — is
    // Finance's and stays here.
    const insertedVenue = await insertFinVenue(payload);

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
        <Filter label="Billing">
          <select
            value={billingFilter}
            onChange={(e) => setBillingFilter(e.target.value as BillingFilter)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All</option>
            <option value="match">Per match</option>
            <option value="share">Profit share</option>
          </select>
        </Filter>
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

      <section className="fc2 overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <style>{FC2_CSS}</style>
        <div className="overflow-x-auto">
          <table data-testid="venues">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Billing</th>
                <th className="r">{`${monthShort(month)} matches`}</th>
                <th className="r">{`${monthShort(month)} cost`}</th>
                <th>
                  Pays on{" "}
                  <small style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>when the money leaves</small>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-sm text-deep-green/55">Loading field costs…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-sm text-deep-green/55">No venues match these filters.</td>
                </tr>
              ) : (
                filtered.map((row, i) => {
                  const expanded = expandedKey === row.key;
                  const venue = venueById.get(row.primaryVenueId) ?? null;
                  const md = data ? matchDaysOf(data, row, month, venue) : [];
                  return (
                    <Fragment key={row.key}>
                      <FieldCostTableRow
                        index={i}
                        row={row}
                        venue={venue}
                        slotExtra={slotExtraFor(row)}
                        expanded={expanded}
                        highlight={lastAdded?.venueId === row.primaryVenueId}
                        onToggle={() => setExpandedKey(expanded ? null : row.key)}
                        month={month}
                        matchDays={md}
                      />
                      {expanded && venue && data && (
                        <VenuePanel
                          index={i}
                          row={row}
                          venue={venue}
                          month={month}
                          matchDays={md}
                          fields={fieldsFor(row)}
                          error={errorFor(row.primaryVenueId)}
                          scheduleRows={buildMatchLineItems(data, row, month)}
                          onPatch={(patch, field) => void saveVenuePatch(row.primaryVenueId, patch, field)}
                          onOverride={(raw) => void saveCustomAmount(row.primaryVenueId, month, raw)}
                          onField={(fieldId, counted) => void saveFieldCounted(row.primaryVenueId, fieldId, counted)}
                        />
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>{monthFull(month)}</td>
                <td />
                <td className="r">{filtered.reduce((a, r) => a + r.matchCount, 0)}</td>
                {/* THE SAME SUM AS THE HEADLINE — both are the rows on screen, so they cannot drift. */}
                <td className="r">{fmtMoney(filtered.reduce((a, r) => a + r.amount, 0))}</td>
                <td />
                <td />
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

/* ── FIELD COSTS v2: THE LIST ROW AND THE VENUE PANEL ──────────────────────────────────────────
 * Spec: scripts/mocks/field-costs-v2.html, asserted by scripts/mocks/field-costs-v2.assert.mjs.
 * Two billing models (per match, profit share), rates by day of week (fin_venues.rate_days), a
 * pay schedule (fin_venues.pay_schedule), a "This month" box that IS the month override, field
 * checkboxes (fin_venue_fields.excluded_from_venue) and notes. Migration 0201.
 *
 * COST vs CASH. Everything in the left column changes what a month COSTS. The pay schedule on the
 * right changes only WHEN the cash leaves — OpEx reads it; Cost and Cities do not.
 *
 * The class names (.pan .g .l .d .on .m .dy …) are the mock's, on purpose: the assert reads them. */

const FC2_CSS = `
.fc2 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.fc2 th,.fc2 td{padding:11px 16px;text-align:left;border-bottom:1px solid #eef1ec;vertical-align:middle}
.fc2 th{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#7a8a81;font-weight:700;background:#f7f9f6}
.fc2 th.r,.fc2 td.r{text-align:right}
.fc2 td.v b{display:block;font-size:15px;color:#10231a}.fc2 td.v span{font-size:12px;color:#7a8a81}
.fc2 .tag{display:inline-block;border:1px solid #e3e7e1;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:#44564c;background:#f7f9f6}
.fc2 .tag.share{background:#eef4ff;border-color:#cfdcf5;color:#2b4f8a}
.fc2 td.cost b{font-size:15px;color:#10231a}.fc2 td.cost small{display:block;font-size:11px;color:#7a8a81;font-weight:500}
.fc2 td.cost small.ov{color:#8a6d00}.fc2 td.cost small.norate{color:#b42318;font-weight:700}
.fc2 td.when b{font-size:14px;display:block;color:#10231a}.fc2 td.when span{font-size:12px;color:#7a8a81}
.fc2 tr.row{cursor:pointer}.fc2 tr.row:hover td{background:#fafbf9}
.fc2 tr.row[aria-expanded="true"] td{background:#f3f6f2}
.fc2 tr.row.hl td{background:#e8f7ee}
.fc2 .chev{color:#7a8a81;font-size:12px}
.fc2 tr.panel td{padding:0;background:#f7f9f6}
.fc2 .pan{padding:12px 22px 14px;border-top:1px solid #e3e7e1;display:grid;grid-template-columns:1fr auto;gap:0 56px}
.fc2 .g{display:grid;grid-template-columns:92px 1fr;gap:6px 12px;align-content:start;align-items:center}
.fc2 .g .l{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:#7a8a81;font-weight:700}
.fc2 .g .v{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:30px;font-size:13.5px;color:#44564c}
.fc2 .in{font:inherit;font-size:13.5px;color:#10231a;background:#fff;border:1px solid #cfd6d1;border-radius:7px;padding:3px 8px;font-weight:700;height:28px}
.fc2 select.in{cursor:pointer}
.fc2 input.in{width:84px;text-align:right}
.fc2 input.in::placeholder{color:#b7c0ba;font-weight:600}
.fc2 .in.ov{border-color:#e0c25a;background:#fffbea}
.fc2 .rate{display:inline-flex;align-items:center;gap:4px}
.fc2 .days{display:inline-flex;gap:2px;margin-left:4px}
.fc2 .dy{width:20px;height:22px;border-radius:5px;border:1px solid #cfd6d1;background:#fff;font:inherit;font-size:10.5px;font-weight:700;color:#b7c0ba;cursor:pointer;padding:0}
.fc2 .dy.on{background:#0b3a28;border-color:#0b3a28;color:#fff}
.fc2 .x{border:0;background:transparent;color:#7a8a81;cursor:pointer;font-size:15px;padding:0 2px;line-height:1}
.fc2 .x:hover{color:#b42318}
.fc2 textarea.in.note{width:100%;max-width:420px;height:auto;min-height:30px;font-weight:500;font-size:13px;resize:vertical;line-height:1.4;padding:5px 8px}
.fc2 .u{color:#7a8a81;font-size:12.5px}
.fc2 .lnk{color:#15803d;font-weight:700;cursor:pointer;font-size:12.5px}
.fc2 .chk{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:#44564c}
.fc2 .chk input{width:15px;height:15px;margin:0;accent-color:#15803d}
.fc2 .err{color:#b42318;font-size:12px;font-weight:700}
.fc2 .when{display:grid;gap:8px;align-content:start}
.fc2 .modes{display:inline-flex;border:1px solid #cfd6d1;border-radius:999px;background:#fff;padding:2px;width:max-content}
.fc2 .modes button{border:0;background:transparent;padding:4px 12px;border-radius:999px;font:inherit;font-size:12.5px;font-weight:700;color:#7a8a81;cursor:pointer}
.fc2 .modes button[aria-pressed="true"]{background:#0b3a28;color:#fff}
.fc2 .cal{display:grid;grid-template-columns:repeat(7,32px);gap:3px;width:max-content}
.fc2 .cal .h{font-size:9.5px;letter-spacing:.6px;color:#7a8a81;font-weight:700;text-align:center;text-transform:uppercase}
.fc2 .cal .mh{grid-column:1/-1;font-size:12px;font-weight:800;color:#44564c;padding:0 2px 2px}
.fc2 .cal .d{height:30px;border-radius:7px;border:1px solid transparent;background:#fff;font:inherit;font-size:12px;color:#44564c;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.fc2 .cal .d:hover{border-color:#9fc9ad}
.fc2 .cal .d.out{visibility:hidden}
.fc2 .cal .d.on{background:#0b3a28;color:#fff;font-weight:800}
.fc2 .cal .d.m{box-shadow:inset 0 -3px 0 #a7d3b6}
.fc2 .cal .d.m.on{box-shadow:inset 0 -3px 0 #22c55e}
.fc2 .amts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:#44564c}
.fc2 .amts .a{display:inline-flex;align-items:center;gap:4px}
.fc2 .amts .a b{color:#10231a}
.fc2 .amts input.in{width:72px;height:26px;font-size:12.5px}
.fc2 .out{font-size:12.5px;color:#7a8a81}
.fc2 .out.warn{color:#8a6d00;font-weight:700}
.fc2 .matches{padding:10px 22px 14px;border-top:1px solid #e3e7e1}
.fc2 .matches th,.fc2 .matches td{padding:4px 10px 4px 0;border-bottom:0;background:transparent}
.fc2 tfoot td{border-top:2px solid #0b3a28;font-weight:800;color:#10231a;background:#fbfdfc}
`;

const money0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "share" covers profit_share AND a partner-dashboard-priced per_match venue (Crossbar): both are
 *  priced by the partner payout, not by a rate. */
function modelOf(row: FieldCostRow): "match" | "share" {
  return row.billingType === "profit_share" || row.dashboardPriced ? "share" : "match";
}

/** The rates the panel edits: rate_days, or one rate on every day from per_match_rate. */
function ratesOf(v: FinVenue | null): DayRate[] {
  if (v?.rate_days && v.rate_days.length) return v.rate_days.map((r) => ({ v: r.v, days: [...r.days] }));
  return [{ v: v?.per_match_rate ?? 0, days: [...ALL_DAYS] }];
}

/** An ACTIVE per-match venue with no rate on file costs $0 and says so (Stony Point, The Sports
 *  Yard, Turf on, 2026-10-02). A rate of 0 that someone TYPED is a rate; NULL is "never set".
 *  Inactive venues are not flagged: nothing is owed there to get wrong. */
function hasNoRate(row: FieldCostRow, v: FinVenue | null): boolean {
  return modelOf(row) === "match" && !!v && v.is_active && v.per_match_rate == null && !v.rate_days;
}

/** The calc line: "8 × $180", or by weekday "4 Mon–Thu × $0 + 13 Fri–Sun × $140". */
function calcText(row: FieldCostRow): string {
  return row.autoFormula.replace(/(\d+) (?:matches|match|reservations|reservation) × /g, "$1 × ");
}

/** The days of the cost month that carry a match, with each one's cost — for the calendar's
 *  underline and for "each match" cash. Charged cancellations count; they are paid. */
function matchDaysOf(data: FinanceData, row: FieldCostRow, month: Q2Month, venue: FinVenue | null): { d: number; amount: number }[] {
  return buildMatchLineItems(data, row, month).map((it) => ({
    d: Number(it.date.slice(8, 10)),
    amount: venue?.rate_days ? rateForYmd(venue.rate_days, venue.per_match_rate, it.date) : it.rate,
  }));
}

function FieldCostTableRow({
  index,
  row,
  venue,
  slotExtra,
  expanded,
  highlight,
  onToggle,
  month,
  matchDays,
}: {
  index: number;
  row: FieldCostRow;
  venue: FinVenue | null;
  slotExtra: { extra: number; twoPitch: number };
  expanded: boolean;
  highlight: boolean;
  onToggle: () => void;
  month: Q2Month;
  matchDays: { d: number; amount: number }[];
}) {
  const model = modelOf(row);
  const p = monthParts(month);
  const ov = row.override != null;
  const when = p
    ? paysOnText(venue?.pay_schedule ?? null, p.year, p.month0, row.amount, row.matchCount, matchDays)
    : { b: "—", s: "" };
  return (
    <tr
      className={`row${highlight ? " hl" : ""}`}
      data-testid={`row-${index}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <td className="v">
        <b>{row.displayName}</b>
        <span>{row.city}</span>
      </td>
      <td>
        <span className={`tag${model === "share" ? " share" : ""}`} data-testid={`tag-${index}`}>
          {model === "share" ? "Profit share" : `Per match · ${rateLabel(venue?.rate_days ?? null, venue?.per_match_rate ?? 0)}`}
        </span>
      </td>
      <td className="r">
        {row.matchCount + slotExtra.extra}
        {slotExtra.twoPitch > 0 && (
          <small
            data-testid="fc-two-pitch"
            className="block text-[10.5px] text-deep-green/50"
            title={`${slotExtra.twoPitch} match${slotExtra.twoPitch === 1 ? "" : "es"} occupied both 9v9 pitches and counts as two. Cost is unaffected — each is billed once, at the two-pitch rate.`}
          >
            {row.matchCount - slotExtra.twoPitch}+{slotExtra.twoPitch}×2
          </small>
        )}
      </td>
      <td className="r cost" data-cost={r2(row.amount)}>
        <b>{money0(row.amount)}</b>
        {ov ? (
          <small className="ov">set by hand · computed {money0(row.autoAmount)}</small>
        ) : model === "share" ? (
          <small>partner payout</small>
        ) : (
          <small>{calcText(row)}</small>
        )}
        {hasNoRate(row, venue) && <small className="norate">no rate</small>}
      </td>
      <td className="when" data-testid={`when-${index}`}>
        <b>{when.b}</b>
        <span>{when.s}</span>
      </td>
      <td className="chev">{expanded ? "▾" : "▸"}</td>
    </tr>
  );
}

/* A TEXT BOX THAT SAVES ON COMMIT — the DOM's own "change": Enter, or leaving the box after
 * editing it. Never per keystroke: typing "500" must be one write, not three ($5, $50, $500).
 * React's onChange is the per-keystroke "input" event, so the native listener is attached here. */
function CommitInput({ onCommit, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & { onCommit: (raw: string) => void } & Record<`data-${string}`, unknown>) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onCommit);
  cb.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cb.current(el.value);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  return <input ref={ref} {...rest} />;
}

type FieldBox = { fieldId: number; title: string; on: boolean };

function VenuePanel({
  index,
  row,
  venue,
  month,
  matchDays,
  fields,
  error,
  scheduleRows,
  onPatch,
  onOverride,
  onField,
}: {
  index: number;
  row: FieldCostRow;
  venue: FinVenue;
  month: Q2Month;
  matchDays: { d: number; amount: number }[];
  fields: FieldBox[];
  error: string | null;
  scheduleRows: MatchLineItem[];
  /** Write these fin_venues columns. The caller sends only what differs from the row on file. */
  onPatch: (patch: VenuePatch, key: EditableField) => void;
  onOverride: (raw: string) => void;
  onField: (fieldId: number, counted: boolean) => void;
}) {
  const model = modelOf(row);
  const ov = row.override != null;
  const comp = r2(row.autoAmount);
  const rates = ratesOf(venue);
  const sched: PaySchedule = venue.pay_schedule ?? { mode: "match" };
  const p = monthParts(month) ?? { year: 2026, month0: 0 };
  const prepaid = sched.mode === "dates" && sched.prepaid === true;
  const dy = prepaid && p.month0 === 0 ? p.year - 1 : p.year;
  const dm = prepaid ? (p.month0 + 11) % 12 : p.month0;
  const dim = new Date(Date.UTC(dy, dm + 1, 0)).getUTCDate();
  const ymd = (d: number) => `${dy}-${pad2(dm + 1)}-${pad2(d)}`;
  const cash = cashDays(sched, dy, dm, row.amount, matchDays);
  const onDays = new Set(cash.days.map((x) => x.d));
  const md = new Set(prepaid ? [] : matchDays.map((m) => m.d));
  const result = payResultText(sched, p.year, p.month0, row.amount, matchDays);

  // ── rates ──
  const saveRates = (next: DayRate[]) => {
    if (next.length === 1) onPatch({ rate_days: null, per_match_rate: next[0].v }, "rate_days");
    else onPatch({ rate_days: next.map((r) => ({ v: r.v, days: [...r.days].sort((a, b) => a - b) })) }, "rate_days");
  };
  const addRate = () => {
    const used = new Set(rates.flatMap((r) => r.days));
    let take = ALL_DAYS.filter((d) => !used.has(d));
    if (!take.length) {
      if (rates.length === 1) take = [5, 6];   // the weekend, as the mock does
      else {
        const big = [...rates].sort((a, b) => b.days.length - a.days.length)[0];
        if (big.days.length < 2) return;
        take = [big.days[big.days.length - 1]];
      }
    }
    const next = rates.map((r) => ({ ...r, days: r.days.filter((d) => !take.includes(d)) }));
    next.push({ v: rates[0].v, days: take });
    saveRates(next.filter((r) => r.days.length));
  };
  const delRate = (j: number) => {
    const next = rates.map((r) => ({ ...r, days: [...r.days] }));
    const gone = next.splice(j, 1)[0];
    next[0].days.push(...gone.days);
    saveRates(next);
  };
  const flipDay = (j: number, d: number) => {
    const next = rates.map((r) => ({ ...r, days: [...r.days] }));
    const r = next[j];
    if (r.days.includes(d)) {
      // Each day belongs to exactly one rate: a day taken off this rate goes to another.
      if (r.days.length < 2) return;
      r.days = r.days.filter((x) => x !== d);
      next.find((_, k) => k !== j)!.days.push(d);
    } else {
      const from = next.find((x) => x.days.includes(d));
      if (from && from.days.length < 2) return;   // never leave a rate with no days
      for (const x of next) x.days = x.days.filter((y) => y !== d);
      r.days.push(d);
    }
    saveRates(next);
  };
  const setRate = (j: number, raw: string) => {
    const n = raw.trim() === "" ? null : Number(raw);
    if (n == null || !Number.isFinite(n) || n < 0) return;
    if (rates.length === 1) { onPatch({ per_match_rate: n }, "per_match_rate"); return; }
    saveRates(rates.map((r, k) => (k === j ? { ...r, v: n } : r)));
  };

  // ── pay schedule ──
  const saveSched = (next: PaySchedule) => onPatch({ pay_schedule: next }, "pay_schedule");
  const setMode = (k: PaySchedule["mode"]) => {
    if (k === sched.mode) return;
    if (k === "match") return saveSched({ mode: "match" });
    if (k === "dates") {
      const d = sched.mode === "weekly" || sched.mode === "biweekly" ? Number(sched.anchor.slice(8, 10)) : 1;
      return saveSched({ mode: "dates", dates: [{ d, v: null }], prepaid: false });
    }
    const anchor = sched.mode === "weekly" || sched.mode === "biweekly"
      ? sched.anchor
      : `${p.year}-${pad2(p.month0 + 1)}-${pad2(sched.mode === "dates" ? Math.min(sched.dates[0]?.d ?? 1, new Date(Date.UTC(p.year, p.month0 + 1, 0)).getUTCDate()) : 1)}`;
    saveSched({ mode: k, anchor });
  };
  const clickDay = (d: number) => {
    if (sched.mode === "dates") {
      const has = sched.dates.some((x) => x.d === d);
      if (has && sched.dates.length < 2) return;   // the last date stays
      const dates = has ? sched.dates.filter((x) => x.d !== d) : [...sched.dates, { d, v: null }];
      saveSched({ ...sched, dates: dates.sort((a, b) => a.d - b.d) });
    } else if (sched.mode === "weekly" || sched.mode === "biweekly") {
      saveSched({ mode: sched.mode, anchor: ymd(d) });
    }
  };
  const setAmt = (d: number, raw: string) => {
    if (sched.mode !== "dates") return;
    const t = raw.trim();
    const v = t === "" ? null : Number(t);
    if (v != null && (!Number.isFinite(v) || v < 0)) return;
    saveSched({ ...sched, dates: sched.dates.map((x) => (x.d === d ? { d, v } : x)) });
  };

  const lead = (new Date(Date.UTC(dy, dm, 1)).getUTCDay() + 6) % 7;
  const dateList = sched.mode === "dates" ? [...sched.dates].sort((a, b) => a.d - b.d) : [];

  const shareText = row.dashboardPriced ? "Match revenue minus manager pay" : "Partner payout";
  const modelSelect = (
    <select
      className="in"
      data-testid="model"
      value={model}
      disabled={row.dashboardPriced}
      title={row.dashboardPriced ? "Priced by its partner dashboard" : undefined}
      onChange={(e) => onPatch({ billing_type: e.target.value === "share" ? "profit_share" : "per_match" }, "billing_type")}
    >
      <option value="match">Per match</option>
      <option value="share">Profit share</option>
    </select>
  );
  const overrideBox = (
    <>
      $
      <CommitInput
        key={`ov-${venue.id}-${month}-${row.override?.override_amount ?? "auto"}`}
        className={`in${ov ? " ov" : ""}`}
        data-testid="override"
        placeholder={String(comp)}
        defaultValue={ov ? String(row.override!.override_amount) : ""}
        onCommit={onOverride}
      />
      <span className="u" data-testid="calc">
        {ov ? (
          <>
            set by hand · {model === "share" ? "payout" : "auto"} {money0(comp)} ·{" "}
            <span className="lnk" data-clear onClick={() => onOverride("")}>reset</span>
          </>
        ) : model === "share" ? (
          "auto · this month's payout"
        ) : (
          `auto · ${calcText(row)}`
        )}
      </span>
    </>
  );

  return (
    <tr className="panel" data-testid={`panel-${index}`}>
      <td colSpan={6}>
        <div className="pan">
          <div className="g">
            <div className="l">Billing</div>
            {model === "share" ? (
              <div className="v">
                {modelSelect}
                <span className="u">
                  {shareText} · <Link className="lnk" href="/match-ops/partner-dashboards">Partners</Link>
                </span>
              </div>
            ) : (
              <div className="v">
                {modelSelect}
                {rates.map((r, j) => (
                  <span className="rate" data-testid={`rate-${j}`} key={`${venue.id}-${j}-${rates.length}`}>
                    $
                    <CommitInput
                      key={`${venue.id}-${j}-${r.v}-${rates.length}`}
                      className="in"
                      data-testid="rate"
                      defaultValue={rates.length === 1 && venue.per_match_rate == null && !venue.rate_days ? "" : String(r.v)}
                      placeholder="rate"
                      onCommit={(raw) => setRate(j, raw)}
                    />{" "}
                    {rates.length > 1 ? (
                      <>
                        <span className="days">
                          {DAY_CHIP.map((l, d) => (
                            <button
                              type="button"
                              key={d}
                              className={`dy${r.days.includes(d) ? " on" : ""}`}
                              title={DAY_LONG[d]}
                              onClick={() => flipDay(j, d)}
                            >
                              {l}
                            </button>
                          ))}
                        </span>
                        <button type="button" className="x" data-delrate={j} aria-label="Remove rate" onClick={() => delRate(j)}>
                          ×
                        </button>
                      </>
                    ) : (
                      <span className="u">/ match</span>
                    )}
                  </span>
                ))}
                {rates.length < 3 && (
                  <span className="lnk" data-testid="add-rate" onClick={addRate}>
                    + rate for other days
                  </span>
                )}
              </div>
            )}
            {model === "match" && (
              <>
                <div className="l">Cancelled</div>
                <div className="v">
                  <label className="chk">
                    <input
                      type="checkbox"
                      data-testid="cancels"
                      checked={venue.charge_on_cancel === true}
                      onChange={(e) => onPatch({ charge_on_cancel: e.target.checked }, "charge_on_cancel")}
                    />{" "}
                    billed
                  </label>
                </div>
              </>
            )}
            <div className="l">This month</div>
            <div className="v">{overrideBox}</div>
            {fields.length > 1 && (
              <>
                <div className="l">Fields</div>
                <div className="v">
                  {fields.map((f, j) => (
                    <label className="chk" key={f.fieldId} title="An unchecked field stays linked but leaves this venue's matches, revenue and cost">
                      <input
                        type="checkbox"
                        data-field={j}
                        checked={f.on}
                        onChange={(e) => onField(f.fieldId, e.target.checked)}
                      />
                      {f.title}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="l">Notes</div>
            <div className="v">
              <textarea
                key={`notes-${venue.id}`}
                className="in note"
                rows={1}
                data-testid="notes"
                placeholder="Anything worth remembering about this venue"
                defaultValue={venue.notes ?? ""}
                onBlur={(e) => {
                  const next = e.target.value.trim() === "" ? null : e.target.value;
                  if (next !== (venue.notes ?? null)) onPatch({ notes: next }, "notes");
                }}
              />
            </div>
            {error && (
              <>
                <div />
                <div className="v err" data-testid="panel-error">{error}</div>
              </>
            )}
          </div>
          <div className="when">
            <div className="modes" data-testid="modes">
              {([["dates", "Pick dates"], ["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["match", "Each match"]] as const).map(([k, l]) => (
                <button type="button" key={k} data-mode={k} aria-pressed={sched.mode === k} onClick={() => setMode(k)}>
                  {l}
                </button>
              ))}
            </div>
            {sched.mode === "match" ? (
              <div className="out" data-testid="when-calc" style={{ marginTop: 4 }}>
                {row.matchCount} matches · <b>{model === "share" ? "its share" : rateLabel(venue.rate_days ?? null, venue.per_match_rate ?? 0)}</b> each, on the match date · auto
              </div>
            ) : (
              <>
                <div className="cal" data-testid="cal">
                  <div className="mh">
                    {prepaid ? `${venuePayMonthName(dm)} ${dy} · pays for ${venuePayMonthName(p.month0)}` : `${venuePayMonthName(dm)} ${dy}`}
                  </div>
                  {DAY_SHORT.map((d) => (
                    <div className="h" key={d}>{d}</div>
                  ))}
                  {Array.from({ length: lead }, (_, k) => (
                    <div className="d out" key={`o${k}`} />
                  ))}
                  {Array.from({ length: dim }, (_, k) => k + 1).map((d) => (
                    <button
                      type="button"
                      key={d}
                      className={`d${onDays.has(d) ? " on" : ""}${md.has(d) ? " m" : ""}`}
                      data-d={d}
                      data-testid={`cal-${d}`}
                      title={md.has(d) ? "match day" : ""}
                      onClick={() => clickDay(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
                {sched.mode === "dates" && dateList.length > 1 && (
                  <div className="amts" data-testid="amts">
                    {dateList.map((x) => (
                      <span className="a" key={x.d}>
                        <b>{venuePayMonthShort(dm)} {x.d}</b> $
                        <CommitInput
                          key={`amt-${venue.id}-${x.d}-${x.v ?? ""}`}
                          className="in"
                          data-testid={`amt-${x.d}`}
                          placeholder="split"
                          defaultValue={x.v == null ? "" : String(x.v)}
                          onCommit={(raw) => setAmt(x.d, raw)}
                        />
                      </span>
                    ))}
                  </div>
                )}
                {sched.mode === "dates" && (
                  <label className="chk" style={{ fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      data-testid="prepaid"
                      checked={prepaid}
                      onChange={(e) => saveSched({ ...sched, prepaid: e.target.checked })}
                    />{" "}
                    prepaid, month before
                  </label>
                )}
                <div className={`out${result.warn ? " warn" : ""}`} data-testid="when-calc">
                  {result.html}
                </div>
              </>
            )}
          </div>
        </div>
        {row.billingType === "per_match" && row.legs.length > 0 && (
          <div className="matches">
            <PerMatchExpand row={row} scheduleRows={scheduleRows} />
          </div>
        )}
      </td>
    </tr>
  );
}

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
