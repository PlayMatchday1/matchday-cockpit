"use client";

// Multi-month "Add expense" drawer for the redesigned Expenses page. Most
// expenses recur, so instead of adding one row at a time this books a line item
// across every month it should land on, in one pass. It writes through the ONE
// shared path (insertFinExpense — logged, manual_entry=true) N times, skips
// months that already carry the same (city, category, vendor) row so a second
// click can't duplicate a cost, and shows the exact rows it will write before
// it writes them.

import { useEffect, useMemo, useState } from "react";
import { insertFinExpense } from "@/lib/finExpenseWrites";
import {
  monthOrd,
  ordToMonthKey,
  seriesKeyOf,
} from "@/lib/recurringExpenses";
import type { QuarterInfo } from "@/lib/quarters";
import type { AppUser } from "@/lib/useAuth";
import type { FinExpense } from "@/lib/useFinanceData";

const SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Match the group key the recurring grid / dupe check use (normalized vendor).
function dupeKey(city: string, category: string, vendor: string, ord: number): string {
  const pseudo = {
    city,
    category,
    vendor,
  } as FinExpense;
  return `${seriesKeyOf(pseudo)}||${ord}`;
}

function ymd(ord: number, dd: number): string {
  const year = Math.floor((ord - 1) / 12);
  const m0 = (ord - 1) % 12; // 0-based
  return `${year}-${String(m0 + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
function monthLength(ord: number): number {
  const year = Math.floor((ord - 1) / 12);
  const m0 = (ord - 1) % 12;
  return new Date(year, m0 + 1, 0).getDate();
}
// The day the generated rows land on. Recon 0e showed real days include 2, 4,
// 5, 10, 15, 23, 24, 28, 30, 31, so the operator types a free day (1-31) or
// "last day". If a chosen day exceeds a short month, clamp to that month's last
// day and flag it (never silently roll into the next month).
function resolveDate(
  ord: number,
  dayNum: number,
  useLast: boolean,
): { date: string; clamped: boolean } {
  const len = monthLength(ord);
  if (useLast) return { date: ymd(ord, len), clamped: false };
  const wanted = Number.isFinite(dayNum) ? dayNum : 1;
  const dd = Math.min(Math.max(1, wanted), len);
  return { date: ymd(ord, dd), clamped: wanted > len };
}

export default function BatchExpenseDrawer({
  open,
  quarter,
  expenses,
  cities,
  categories,
  appUser,
  seed,
  onClose,
  onDone,
}: {
  open: boolean;
  quarter: QuarterInfo;
  expenses: FinExpense[];
  cities: string[];
  categories: string[];
  appUser: AppUser | null;
  // Optional prefill (e.g. clicking a gap): city/category/vendor + a month to preselect.
  seed?: { city: string; category: string; vendor: string; month?: string } | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const nowOrd = useMemo(() => {
    const n = new Date();
    return n.getFullYear() * 12 + (n.getMonth() + 1);
  }, []);

  // A 9-month booking window starting at the viewed quarter's first month —
  // always spans this quarter + the next two, so This-Q / Next-Q presets land.
  const windowOrds = useMemo(() => {
    const startOrd = monthOrd(quarter.months[0].key);
    return Array.from({ length: 9 }, (_, i) => startOrd + i);
  }, [quarter]);

  const [city, setCity] = useState("Company-wide");
  const [category, setCategory] = useState(categories[0] ?? "Marketing");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  // Single source of truth for the day the rows land on. In single-month mode a
  // native date input edits these (its day-of-month → dayNum); in multi-month
  // mode a number input + "last day" toggle edit them directly. Carrying them
  // across the mode switch is automatic — 1↔many never loses the typed day.
  const [dayNum, setDayNum] = useState("1");
  const [useLast, setUseLast] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset / apply seed each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setSaving(false);
    setDayNum("1");
    setUseLast(false);
    if (seed) {
      setCity(seed.city || "Company-wide");
      setCategory(seed.category);
      setVendor(seed.vendor);
      setPicked(seed.month ? new Set([monthOrd(seed.month)]) : new Set());
    } else {
      setVendor("");
      setAmount("");
      setNotes("");
      setPicked(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const existing = useMemo(() => {
    const s = new Set<string>();
    for (const r of expenses) s.add(dupeKey(r.city, r.category, r.vendor ?? "", monthOrd(r.month)));
    return s;
  }, [expenses]);

  function toggle(ord: number) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(ord)) n.delete(ord);
      else n.add(ord);
      return n;
    });
  }
  function preset(kind: "thisq" | "nextq" | "rest" | "none") {
    if (kind === "none") return setPicked(new Set());
    const startOrd = monthOrd(quarter.months[0].key);
    if (kind === "thisq") return setPicked(new Set([startOrd, startOrd + 1, startOrd + 2]));
    if (kind === "nextq") return setPicked(new Set([startOrd + 3, startOrd + 4, startOrd + 5]));
    // rest of the viewed quarter's calendar year, from now forward
    const yr = quarter.year;
    setPicked(
      new Set(
        windowOrds.filter((o) => Math.floor((o - 1) / 12) === yr && o >= nowOrd),
      ),
    );
  }

  const amt = parseFloat(amount || "");
  const chosen = [...picked].sort((a, b) => a - b);
  const singleOrd = chosen.length === 1 ? chosen[0] : null; // native-date mode
  const dayInt = parseInt(dayNum || "", 10);
  const rowsToWrite = useMemo(() => {
    return chosen.map((ord) => {
      const { date, clamped } = resolveDate(ord, dayInt, useLast);
      const dupe = existing.has(dupeKey(city, category, vendor, ord));
      return { ord, date, clamped, dupe };
    });
  }, [chosen, existing, city, category, vendor, dayInt, useLast]);
  const willCreate = rowsToWrite.filter((r) => !r.dupe);
  const dupes = rowsToWrite.length - willCreate.length;
  const total = willCreate.length * (Number.isFinite(amt) ? amt : 0);
  const canSave =
    !!appUser && willCreate.length > 0 && Number.isFinite(amt) && !saving;

  async function save() {
    if (!appUser) {
      setErr("Not signed in");
      return;
    }
    setSaving(true);
    setErr(null);
    const written: number[] = [];
    try {
      for (const r of willCreate) {
        // r.date is exactly what the preview showed — preview == written row.
        await insertFinExpense(
          {
            date: r.date,
            month: ordToMonthKey(r.ord),
            city: city === "Company-wide" ? null : city,
            category,
            vendor: vendor.trim() || null,
            amount: amt,
            notes: notes.trim() || null,
          },
          appUser,
        );
        written.push(r.ord);
      }
      await onDone();
      onClose();
    } catch (e) {
      // Partial success: report exactly how many landed before the failure so
      // the operator knows the real state, never a silent half-write.
      const msg = e instanceof Error ? e.message : "Save failed.";
      setErr(
        written.length > 0
          ? `Wrote ${written.length} of ${willCreate.length} rows, then failed: ${msg}. Reopen to finish the rest.`
          : msg,
      );
      if (written.length > 0) await onDone();
      setSaving(false);
    }
  }

  return (
    <>
      <div
        onClick={saving ? undefined : onClose}
        className={`fixed inset-0 z-[60] bg-deep-green/40 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed right-0 top-0 z-[70] flex h-screen w-full max-w-[640px] flex-col bg-cream shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-cream-line bg-white px-6 py-5">
          <h2 className="text-lg font-black tracking-tight text-deep-green">Add expense</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-2xl leading-none text-deep-green/50 hover:text-deep-green"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-auto px-6 py-6">
          {/* What */}
          <section>
            <SecTitle>What</SecTitle>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <select value={city} onChange={(e) => setCity(e.target.value)} className={INPUT}>
                  {cities.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className={INPUT}
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vendor / who">
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  className={INPUT}
                  placeholder="e.g. Garrett"
                />
              </Field>
              <Field label="Amount">
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={INPUT}
                  placeholder="0.00"
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Notes">
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className={INPUT}
                  placeholder="optional"
                />
              </Field>
            </div>
          </section>

          {/* When */}
          <section>
            <SecTitle>
              When — pick every month this should be booked
              <span className="ml-1 font-normal normal-case tracking-normal text-deep-green/45">
                · not limited to the quarter you&apos;re viewing
              </span>
            </SecTitle>
            <div className="mb-3 flex flex-wrap gap-2">
              <Quick onClick={() => preset("thisq")}>This quarter ({quarter.label})</Quick>
              <Quick onClick={() => preset("nextq")}>Next quarter</Quick>
              <Quick onClick={() => preset("rest")}>Rest of {quarter.year}</Quick>
              <Quick onClick={() => preset("none")}>Clear</Quick>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {windowOrds.map((ord) => {
                const on = picked.has(ord);
                const dupe = on && existing.has(dupeKey(city, category, vendor, ord));
                const past = ord < nowOrd;
                const yr = Math.floor((ord - 1) / 12);
                const label = `${SHORT[(ord - 1) % 12]}${yr !== quarter.year ? " " + String(yr).slice(2) : ""}`;
                return (
                  <button
                    key={ord}
                    type="button"
                    onClick={() => toggle(ord)}
                    className={`rounded-lg border px-2 py-2 text-xs font-bold transition ${
                      dupe
                        ? "border-amber-400 bg-amber-50 text-amber-800"
                        : on
                          ? "border-mint bg-mint text-deep-green"
                          : `border-cream-line bg-white text-deep-green hover:border-mint ${past ? "opacity-50" : ""}`
                    }`}
                    title={dupe ? "Already booked — will skip" : undefined}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {singleOrd !== null ? (
              // Exactly one month → record the real date. Constrained to that
              // month; the value written is this date verbatim.
              <div className="mt-4 max-w-[240px]">
                <Field label="Date">
                  <input
                    type="date"
                    value={resolveDate(singleOrd, dayInt, useLast).date}
                    min={ymd(singleOrd, 1)}
                    max={ymd(singleOrd, monthLength(singleOrd))}
                    onChange={(e) => {
                      const d = parseInt((e.target.value.split("-")[2] ?? ""), 10);
                      if (Number.isFinite(d)) {
                        setDayNum(String(d));
                        setUseLast(false);
                      }
                    }}
                    className={INPUT}
                  />
                </Field>
              </div>
            ) : (
              // Two or more months → one day-of-month applied to each. Free
              // 1-31 (recon 0e), or last day; short months clamp (flagged in
              // the preview).
              <div className="mt-4 flex flex-wrap items-end gap-4">
                <div className="max-w-[150px]">
                  <Field label="Day of month">
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={dayNum}
                      disabled={useLast}
                      onChange={(e) => setDayNum(e.target.value)}
                      className={`${INPUT} ${useLast ? "opacity-50" : ""}`}
                    />
                  </Field>
                </div>
                <label className="flex items-center gap-2 pb-2.5 text-xs font-bold text-deep-green">
                  <input
                    type="checkbox"
                    checked={useLast}
                    onChange={(e) => setUseLast(e.target.checked)}
                    className="h-4 w-4 accent-deep-green"
                  />
                  Last day of month
                </label>
              </div>
            )}
            {dupes > 0 && (
              <div className="mt-3 flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-800">
                <span aria-hidden>⚠</span>
                <div>
                  <b className="font-black">
                    {dupes} month{dupes === 1 ? "" : "s"} already ha{dupes === 1 ? "s" : "ve"} this
                    expense.
                  </b>{" "}
                  They&apos;re highlighted above and will be skipped, not duplicated. Uncheck them
                  if you meant a second payment that month.
                </div>
              </div>
            )}
          </section>

          {/* Preview */}
          <section>
            <SecTitle>This will create</SecTitle>
            <div className="overflow-hidden rounded-xl border border-cream-line bg-white">
              <div className="flex items-center justify-between border-b border-cream-line/70 px-4 py-2.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-deep-green/70">
                  Rows to be written to fin_expenses
                </span>
                <span className="text-[11px] text-deep-green/55">
                  {willCreate.length} row{willCreate.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="max-h-[220px] overflow-auto">
                {rowsToWrite.length === 0 || !Number.isFinite(amt) ? (
                  <div className="px-4 py-6 text-center text-xs text-deep-green/55">
                    Pick at least one month and an amount.
                  </div>
                ) : (
                  rowsToWrite.map((r) => (
                    <div
                      key={r.ord}
                      className={`flex items-center gap-2 border-b border-cream-line/50 px-4 py-2 text-xs last:border-0 ${
                        r.dupe ? "bg-amber-50" : ""
                      }`}
                    >
                      <span className="font-bold tabular-nums text-deep-green">{r.date}</span>
                      <span className="flex-1 text-[11px] text-deep-green/55">
                        {city} · {category} · {vendor || "—"}
                        {r.clamped && (
                          <span className="ml-1 font-bold text-amber-700">
                            · day {dayInt} clamped to month end
                          </span>
                        )}
                      </span>
                      {r.dupe ? (
                        <span className="text-[10px] font-bold text-amber-700">
                          already booked — will skip
                        </span>
                      ) : (
                        <span className="font-black tabular-nums text-coral">{money(amt)}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          {err && (
            <div className="rounded-xl border border-coral/40 bg-coral-soft/40 px-3 py-2.5 text-xs font-semibold text-coral">
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-cream-line bg-white px-6 py-4">
          <div className="text-xs text-deep-green/55">
            {willCreate.length ? (
              <>
                Creates <b className="text-sm font-black text-deep-green">{willCreate.length} rows</b>{" "}
                · <b className="font-black text-deep-green">{money(total)}</b> total
                {dupes ? ` · ${dupes} skipped` : ""}
              </>
            ) : (
              "Nothing to create"
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-full border border-cream-line bg-white px-5 py-2 text-sm font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-full bg-mint px-5 py-2 text-sm font-black text-deep-green hover:bg-mint-hover disabled:opacity-40"
            >
              {saving ? "Creating…" : `Create ${willCreate.length || ""} row${willCreate.length === 1 ? "" : "s"}`.trim()}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

const INPUT =
  "w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-sm font-semibold text-deep-green focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/40";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[9.5px] font-black uppercase tracking-[0.12em] text-deep-green/55">
        {label}
      </div>
      {children}
    </label>
  );
}
function SecTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-deep-green/55">
      <span>{children}</span>
      <span className="h-px flex-1 bg-cream-line" />
    </div>
  );
}
function Quick({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-[11px] font-bold text-deep-green hover:border-mint"
    >
      {children}
    </button>
  );
}
