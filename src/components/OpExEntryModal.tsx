"use client";

// Add / edit an OpEx entry. Opens from the "+ Add expense" button
// (create) or a click on any editable pill (edit). City Manager Pay
// rows are derived + read-only, so they never open this modal.

import { useEffect, useState } from "react";
import {
  OPEX_CATEGORIES,
  RECURRENCES,
  type OpexCategory,
  type OpexDraft,
  type OpexEntry,
  type Recurrence,
} from "@/lib/opex";

const labelCls =
  "flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-deep-green/60";
const inputCls =
  "h-11 rounded-lg border border-cream-line bg-white px-3 text-sm font-medium normal-case tracking-normal text-deep-green focus:border-deep-green/50 focus:outline-none";

export default function OpExEntryModal({
  entry,
  createdBy,
  onSave,
  onDelete,
  onClose,
}: {
  entry: OpexEntry | null;
  createdBy: string | null;
  onSave: (id: string | null, draft: OpexDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const editing = entry != null;
  const [category, setCategory] = useState<OpexCategory>(
    entry?.category ?? "field_cost",
  );
  const [subcategory, setSubcategory] = useState(entry?.subcategory ?? "");
  const [amount, setAmount] = useState(
    entry ? String(entry.amount) : "",
  );
  const [date, setDate] = useState(entry?.scheduled_date ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(
    entry?.recurrence ?? "one_time",
  );
  const [ends, setEnds] = useState(entry?.recurrence_end ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function save() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      setErr("Enter a valid amount.");
      return;
    }
    if (!date) {
      setErr("Pick a date.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const draft: OpexDraft = {
        category,
        subcategory: subcategory.trim() || null,
        amount: amt,
        scheduled_date: date,
        recurrence,
        recurrence_end: recurrence === "one_time" ? null : ends || null,
        notes: notes.trim() || null,
      };
      await onSave(editing ? entry!.id : null, draft);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function del() {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      await onDelete(entry!.id);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-cream-soft shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cream-line bg-white px-5 py-3">
          <h3 className="text-base font-bold text-deep-green">
            {editing ? "Edit expense" : "Add expense"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-deep-green/40 transition hover:text-deep-green"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3 p-5">
          <label className={labelCls}>
            Category
            <select
              className={inputCls}
              value={category}
              onChange={(e) => setCategory(e.target.value as OpexCategory)}
            >
              {OPEX_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className={labelCls}>
            Subcategory
            <input
              className={inputCls}
              value={subcategory}
              onChange={(e) => setSubcategory(e.target.value)}
              placeholder="e.g. Meta Ads, PRUMC, VEO Cam"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Amount
              <input
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                className={inputCls}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <label className={labelCls}>
              Date
              <input
                type="date"
                className={inputCls}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Recurrence
              <select
                className={inputCls}
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value as Recurrence)}
              >
                {RECURRENCES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Ends
              <input
                type="date"
                className={inputCls}
                value={ends}
                disabled={recurrence === "one_time"}
                onChange={(e) => setEnds(e.target.value)}
              />
            </label>
          </div>

          <label className={labelCls}>
            Notes
            <textarea
              className={`${inputCls} h-20 py-2`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </label>

          {err && (
            <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-cream-line bg-white px-5 py-3">
          {editing && confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-coral-hover">
                Delete this expense?
              </span>
              <button
                type="button"
                onClick={del}
                disabled={busy}
                className="rounded-full bg-coral px-3 py-1.5 text-xs font-bold text-cream transition hover:bg-coral-hover disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green/65 transition hover:bg-cream-soft disabled:opacity-50"
              >
                No
              </button>
            </div>
          ) : (
            <>
              {editing ? (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={busy}
                  className="rounded-full border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs font-bold text-coral-hover transition hover:bg-coral-soft/70 disabled:opacity-50"
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green/65 transition hover:bg-cream-soft disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={busy}
                  className="rounded-full bg-deep-green px-4 py-1.5 text-xs font-bold text-cream transition hover:bg-deep-green-soft disabled:opacity-50"
                >
                  {busy ? "Saving…" : editing ? "Save" : "Add"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
