"use client";

// REGISTERED PLAYERS — the table under Player Lookup's search box.
//
// IT IS A REGISTRATION LIST. Newest signup first, because the question it exists to answer is
// "who joined this week" while a city launches. Every column sorts, but that default is the point
// of the thing.
//
// ONE RULE, SO NO BASIS COLUMN. The list was briefly a union — signups plus anyone on one of the
// city's rosters — and the roster half turned out to be eleven placeholder accounts sitting on
// Warsaw matches to fill them. With a single rule there is nothing to distinguish, so the column
// and its split line are gone rather than left showing the same word on every row.
//
// EVERY EMPTY CELL IS A DASH, never blank: 6,437 of 30,387 players have no phone, and a player who
// has never played gets a dash rather than a date. A blank cell reads as a rendering bug.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Row = {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  registered: string | null;
  last_match: string | null;
  member: boolean;
  city: string | null;
};

type Payload = {
  players: Row[];
  total: number;
  page: number;
  size: number;
  sort: string;
  dir: "asc" | "desc";
  sortNote: string | null;
  scope: string | null;
  scopeName: string | null;
  syncedAt: string | null;
  error?: string;
};

const COLUMNS: { key: string; label: string; align?: "right" | "left" }[] = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "registered", label: "Registered" },
  { key: "last_match", label: "Last match" },
  { key: "member", label: "Member" },
];

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

export default function RegisteredPlayersTable({ onOpen }: { onOpen?: (id: number) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState("registered");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const size = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const res = await fetch(
        `/api/players/registered?sort=${sort}&dir=${dir}&page=${page}&size=${size}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" },
      );
      const json = (await res.json()) as Payload;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sort, dir, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = useMemo(() => (data ? Math.max(1, Math.ceil(data.total / data.size)) : 1), [data]);

  const clickSort = (key: string) => {
    if (key === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      // Dates read newest-first by default; text reads A-Z. Anything else surprises.
      setDir(key === "registered" || key === "last_match" ? "desc" : "asc");
    }
    setPage(1);
  };

  return (
    <div className="panel" data-testid="registered-panel">
      <div className="ptitle">
        <h3>REGISTERED PLAYERS</h3>
        <span className="note" data-testid="registered-count">
          {loading && !data ? "loading…" : data ? `${data.total.toLocaleString()} player${data.total === 1 ? "" : "s"}` : ""}
          {data?.scopeName ? ` · ${data.scopeName}` : ""}
        </span>
      </div>

      {/* THE MIRROR'S CLOCK. Without this, a registration from an hour ago that has not synced yet
          reads as a broken filter — and the person reading it is watching a city launch. */}
      <div className="rp-fresh" data-testid="registered-freshness">
        Mirrored data · last synced {fmtWhen(data?.syncedAt ?? null)}
        {data?.syncedAt ? ` (${new Date(data.syncedAt).toLocaleString()})` : ""}. A signup newer than
        that is not here yet. <button type="button" className="rp-refresh" onClick={() => void load()} data-testid="registered-refresh">Refresh</button>
      </div>

      {data?.sortNote && <div className="rp-note" data-testid="registered-sortnote">{data.sortNote}</div>}
      {err && <p className="empty" data-testid="registered-err"><b>Could not load players</b>{err}</p>}

      {!err && (
        <div className="rp-wrap">
          <table className="rp" data-testid="registered-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    data-testid={`rp-th-${c.key}`}
                    aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" onClick={() => clickSort(c.key)}>
                      {c.label}
                      {sort === c.key && <i aria-hidden>{dir === "asc" ? " ▲" : " ▼"}</i>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.players.map((p) => (
                <tr key={p.id} data-testid="rp-row" data-pid={p.id}>
                  <td className="mono">
                    {onOpen ? (
                      <button type="button" className="rp-id" onClick={() => onOpen(p.id)}>{p.id}</button>
                    ) : p.id}
                  </td>
                  <td>{p.name ?? "—"}</td>
                  <td>{p.email ?? "—"}</td>
                  {/* IN FULL. This is the operator's own player list, not a log — the last-4 rule
                      is about change_log, which nothing here writes to. */}
                  <td className="mono" data-testid="rp-phone">{p.phone ?? "—"}</td>
                  <td data-testid="rp-registered" data-iso={p.registered ?? ""}>{fmtDate(p.registered)}</td>
                  <td data-testid="rp-lastmatch">{fmtDate(p.last_match)}</td>
                  {/* A PLAIN MARKER, not a badge — a badge here reads like an account status. */}
                  <td data-testid="rp-member">{p.member ? "yes" : "no"}</td>
                </tr>
              ))}
              {data && data.players.length === 0 && !loading && (
                <tr><td colSpan={COLUMNS.length}><p className="empty" data-testid="registered-empty"><b>No players</b>Nothing matches this city yet.</p></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && pages > 1 && (
        <div className="rp-pager" data-testid="registered-pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span>Page {data.page} of {pages.toLocaleString()}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}

      <style jsx>{`
        .rp-fresh { padding: 0 14px 10px; font-size: 11px; color: #98a29b; line-height: 1.5; }
        .rp-refresh { border: 1px solid #e3e7e0; background: #fff; border-radius: 6px;
          padding: 2px 8px; font: inherit; font-size: 11px; color: #12291d; cursor: pointer; }
        .rp-note { padding: 0 14px 8px; font-size: 11px; color: #b06a2c; }
        .rp-wrap { overflow-x: auto; }
        table.rp { width: 100%; border-collapse: collapse; }
        table.rp th { text-align: left; font-size: 10px; letter-spacing: .07em; text-transform: uppercase;
          color: #6d7a70; font-weight: 700; border-bottom: 1px solid #e3e7e0; background: #f7f8f5;
          padding: 0; white-space: nowrap; }
        table.rp th button { all: unset; cursor: pointer; display: block; padding: 8px 12px; width: 100%; }
        table.rp th button:hover { color: #12291d; }
        table.rp td { padding: 9px 12px; font-size: 13px; border-bottom: 1px solid #eef1ea;
          white-space: nowrap; color: #12291d; }
        table.rp td.mono { font-variant-numeric: tabular-nums; }
        .rp-id { all: unset; cursor: pointer; text-decoration: underline; }
        table.rp tbody tr:hover td { background: #fafbf9; }
        .rp-pager { display: flex; align-items: center; gap: 12px; padding: 10px 14px; font-size: 12px; color: #6d7a70; }
        .rp-pager button { border: 1px solid #e3e7e0; background: #fff; border-radius: 8px;
          padding: 4px 10px; font: inherit; font-size: 12px; color: #12291d; cursor: pointer; }
        .rp-pager button:disabled { opacity: .4; cursor: default; }
      `}</style>
    </div>
  );
}
