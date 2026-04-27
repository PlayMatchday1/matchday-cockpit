"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { selectAll } from "@/lib/supabasePagination";
import type { AuditAction, AuditTable } from "@/lib/financeAudit";

type ChangeLogEntry = {
  id: number;
  table_name: AuditTable;
  row_id: number;
  action: AuditAction;
  changed_at: string;
  changed_by: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  note: string | null;
};

const ALL = "ALL";

function isoDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function fmtMoney(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  const r = Math.round(n);
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

function tableLabel(t: AuditTable): string {
  return t === "fin_revenue" ? "revenue" : "expense";
}

function summarize(entry: ChangeLogEntry): string {
  const lbl = tableLabel(entry.table_name);
  if (entry.action === "insert" && entry.after_json) {
    const r = entry.after_json;
    if (entry.table_name === "fin_revenue") {
      return `Added revenue: ${r.date} · ${r.city} · ${r.source} · ${fmtMoney(r.gross)}`;
    }
    return `Added expense: ${r.date} · ${r.city} · ${r.category} · ${fmtMoney(r.amount)}`;
  }
  if (entry.action === "delete" && entry.before_json) {
    const r = entry.before_json;
    if (entry.table_name === "fin_revenue") {
      return `Deleted revenue: ${r.date} · ${r.city} · ${r.source} · ${fmtMoney(r.gross)}`;
    }
    const v = r.vendor ? ` (Vendor: ${r.vendor})` : "";
    return `Deleted expense: ${r.date} · ${r.city} · ${r.category} · ${fmtMoney(r.amount)}${v}`;
  }
  if (entry.action === "update" && entry.before_json && entry.after_json) {
    const before = entry.before_json;
    const after = entry.after_json;
    const skip = new Set(["id", "manual_entry", "net"]);
    const changes: string[] = [];
    for (const key of Object.keys(after)) {
      if (skip.has(key)) continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        const ov = formatScalar(before[key]);
        const nv = formatScalar(after[key]);
        changes.push(`${key} ${ov} → ${nv}`);
      }
    }
    if (changes.length === 0) {
      return `Updated ${lbl} (id=${entry.row_id}): no field changes`;
    }
    return `Updated ${lbl} (id=${entry.row_id}): ${changes.join(", ")}`;
  }
  return `${entry.action} on ${entry.table_name} (id=${entry.row_id})`;
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return fmtMoney(v) === "" ? String(v) : String(v);
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

export default function ChangeLogView() {
  const [entries, setEntries] = useState<ChangeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const defaultFrom = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return isoDateOnly(d);
  }, []);

  const [tableFilter, setTableFilter] = useState<AuditTable | "ALL">("ALL");
  const [actionFilter, setActionFilter] = useState<AuditAction | "ALL">("ALL");
  const [userFilter, setUserFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState<string>(defaultFrom);
  const [dateTo, setDateTo] = useState<string>("");

  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Paginate via selectAll — `.limit(2000)` is silently truncated by
    // PostgREST's default 1000-row max, so the prior code only ever
    // returned the most-recent 1000 audit entries no matter what filters
    // the user picked.
    selectAll<ChangeLogEntry>(() => {
      let q = supabase
        .from("fin_change_log")
        .select("*")
        .order("changed_at", { ascending: false });
      if (dateFrom) q = q.gte("changed_at", `${dateFrom}T00:00:00`);
      if (dateTo) q = q.lte("changed_at", `${dateTo}T23:59:59`);
      return q;
    })
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load changelog.");
        setEntries([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo]);

  const userOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of entries) if (r.changed_by) set.add(r.changed_by);
    return [ALL, ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    let rows = entries;
    if (tableFilter !== "ALL")
      rows = rows.filter((r) => r.table_name === tableFilter);
    if (actionFilter !== "ALL")
      rows = rows.filter((r) => r.action === actionFilter);
    if (userFilter !== ALL)
      rows = rows.filter((r) => r.changed_by === userFilter);
    return rows;
  }, [entries, tableFilter, actionFilter, userFilter]);

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
          Change Log
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          Every manual add / edit / delete on revenue and expenses, with the
          full before/after diff.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Table">
          <select
            value={tableFilter}
            onChange={(e) =>
              setTableFilter(e.target.value as AuditTable | "ALL")
            }
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All</option>
            <option value="fin_revenue">fin_revenue</option>
            <option value="fin_expenses">fin_expenses</option>
          </select>
        </Filter>
        <Filter label="Action">
          <select
            value={actionFilter}
            onChange={(e) =>
              setActionFilter(e.target.value as AuditAction | "ALL")
            }
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All</option>
            <option value="insert">insert</option>
            <option value="update">update</option>
            <option value="delete">delete</option>
          </select>
        </Filter>
        <Filter label="User">
          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {userOptions.map((u) => (
              <option key={u} value={u}>
                {u === ALL ? "All" : u}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="From">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Filter>
        <Filter label="To">
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Filter>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr className="border-b border-cream-line">
                <th className="w-8 px-3 py-2"></th>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Table</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Summary</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading change log…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    No changes match these filters.
                  </td>
                </tr>
              ) : (
                filtered.map((entry) => {
                  const expanded = expandedId === entry.id;
                  return (
                    <ChangeLogRow
                      key={entry.id}
                      entry={entry}
                      expanded={expanded}
                      onToggle={() =>
                        setExpandedId(expanded ? null : entry.id)
                      }
                    />
                  );
                })
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
              {entries.length.toLocaleString()}
            </span>{" "}
            entries
          </div>
          {entries.length >= 2000 && (
            <div className="text-deep-green/55">
              Capped at 2,000 most-recent rows in window. Narrow the date
              range to see older entries.
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ChangeLogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ChangeLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const actionCls =
    entry.action === "insert"
      ? "bg-mint-soft text-deep-green ring-mint/40"
      : entry.action === "delete"
        ? "bg-coral-soft text-coral ring-coral/40"
        : "bg-cream text-deep-green ring-cream-line";
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-t border-cream-line/40 hover:bg-cream-soft/50"
      >
        <td className="px-3 py-2 text-deep-green/55">
          {expanded ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
        </td>
        <td
          className="whitespace-nowrap px-3 py-2 text-deep-green"
          title={entry.changed_at}
        >
          {relativeTime(entry.changed_at)}
        </td>
        <td className="px-3 py-2 text-deep-green/85">{entry.changed_by}</td>
        <td className="px-3 py-2 font-mono text-deep-green/65">
          {entry.table_name}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${actionCls}`}
          >
            {entry.action}
          </span>
        </td>
        <td className="px-3 py-2 text-deep-green">{summarize(entry)}</td>
      </tr>
      {expanded && (
        <tr className="bg-cream-soft/40">
          <td colSpan={6} className="px-5 py-4">
            <DiffPanel entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

function DiffPanel({ entry }: { entry: ChangeLogEntry }) {
  const before = entry.before_json;
  const after = entry.after_json;

  if (entry.action === "update" && before && after) {
    const skip = new Set(["id", "manual_entry"]);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed: string[] = [];
    for (const k of keys) {
      if (skip.has(k)) continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        changed.push(k);
      }
    }
    return (
      <div className="space-y-3">
        {entry.note && (
          <div className="text-xs italic text-deep-green/65">
            Note: {entry.note}
          </div>
        )}
        {changed.length === 0 ? (
          <div className="text-xs italic text-deep-green/55">
            No fields changed.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                <tr>
                  <th className="py-1 text-left">Field</th>
                  <th className="py-1 text-left">Before</th>
                  <th className="py-1 text-left">After</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((k) => (
                  <tr key={k} className="border-t border-cream-line/40">
                    <td className="py-1 pr-3 text-deep-green">{k}</td>
                    <td className="py-1 pr-3 text-coral">
                      {formatScalar(before[k])}
                    </td>
                    <td className="py-1 text-mint-hover">
                      {formatScalar(after[k])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="text-[11px]">
          <summary className="cursor-pointer text-deep-green/55 hover:text-deep-green">
            Full JSON
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
            <JsonBlock label="Before" data={before} />
            <JsonBlock label="After" data={after} />
          </div>
        </details>
      </div>
    );
  }

  if (entry.action === "insert" && after) {
    return (
      <div className="space-y-2">
        {entry.note && (
          <div className="text-xs italic text-deep-green/65">
            Note: {entry.note}
          </div>
        )}
        <JsonBlock label="After (new row)" data={after} />
      </div>
    );
  }

  if (entry.action === "delete" && before) {
    return (
      <div className="space-y-2">
        {entry.note && (
          <div className="text-xs italic text-deep-green/65">
            Note: {entry.note}
          </div>
        )}
        <JsonBlock label="Before (deleted row)" data={before} />
      </div>
    );
  }

  return (
    <div className="text-xs italic text-deep-green/55">
      No diff data for this entry.
    </div>
  );
}

function JsonBlock({
  label,
  data,
}: {
  label: string;
  data: Record<string, unknown> | null;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        {label}
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-cream-line bg-white p-3 text-[11px] leading-relaxed text-deep-green">
        {JSON.stringify(data, null, 2)}
      </pre>
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
