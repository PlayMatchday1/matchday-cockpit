"use client";

/* CHURN — the page body (rebuilt 2026-11-09, Figma sl6PTy5LhCVj1gF0HvGmuF 32:3). Replaces ChurnPanel and the old
 * Window / Last played after / Not played for controls, the threshold stepper and the $ footer.
 *
 * Everything on screen comes from /api/lifecycle/churn; the rules are in lib/churnModel.ts. The table renders the
 * route's column list, so the CSV (the same list, server side) has the same columns.
 *
 * Message opens the player's WhatsApp chat in Player Chats in a new tab (creating the thread if there is none,
 * sending nothing). The row reads "Messaged [date]" once a message actually goes out from that chat, and "Came
 * back" once they book after it. */

import { useCallback, useEffect, useState } from "react";
import g from "./growth.module.css";
import pa from "./playerActivity.module.css";
import s from "./churn.module.css";
import { useAuth, canAccess } from "@/lib/useAuth";
import { can, type CapRow } from "@/lib/capabilities";
import {
  DAYS_OPTIONS, DAYS_RED, DEFAULT_DAYS, TIERS, TIER_NAME, TIER_SUB, dayLabel, daysLabel, shortChicago,
  type SortDir, type SortKey, type Tier, type Winback,
} from "@/lib/churnModel";

type Row = {
  id: number; name: string | null; phone: string | null; cityName: string; field: string;
  matches: number; managed: number; spentCents: number; last: string; daysGone: number;
  everMember: boolean; exManager: boolean; winback: Winback;
};
type Payload = {
  today: string; refreshedAt: string | null;
  filter: { days: number; since: string; city: string | null; field: number | null; tier: Tier | null; sort: SortKey; dir: SortDir };
  cities: { code: string; name: string; players: number }[];
  fields: { key: number; label: string; players: number }[];
  liveFieldsKnown: boolean;
  counts: { all: number; heavy: number; regular: number; tried: number };
  total: number; page: number; pageSize: number;
  columns: { key: string; label: string }[];
  rows: Row[];
  excluded: { formerStaff: number; deleted: number };
};

const SORTABLE: Record<string, SortKey> = { player: "name", city: "city", field: "field", matches: "matches", spent: "spent", last: "last", days: "days" };
const SORT_LABEL: Record<SortKey, string> = { name: "player", city: "city", field: "usual field", matches: "matches played", spent: "spent", last: "last played", days: "days gone" };
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const int = (n: number) => n.toLocaleString("en-US");

export default function ChurnView({ authHeaders }: { authHeaders: Record<string, string> }) {
  const { appUser } = useAuth();
  const canMessage = !!appUser && canAccess(appUser, "chats") && can(appUser as unknown as CapRow, "sendMessages", appUser.email);

  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [since, setSince] = useState<string>("");
  const [city, setCity] = useState<string>("all");
  const [field, setField] = useState<string>("all");
  const [tier, setTier] = useState<Tier | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "matches", dir: "desc" });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCsv, setBusyCsv] = useState(false);
  const [msgState, setMsgState] = useState<Record<number, string>>({});

  const token = authHeaders.Authorization;
  const query = useCallback((extra = "") => {
    const q = new URLSearchParams({ days: String(days), city, field, sort: sort.key, dir: sort.dir, page: String(page) });
    if (since) q.set("since", since);
    if (tier) q.set("tier", tier);
    return `/api/lifecycle/churn?${q.toString()}${extra}`;
  }, [days, since, city, field, tier, sort, page]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setError(null);
    (async () => {
      try {
        const res = await fetch(query(), { headers: { Authorization: token } });
        const body = (await res.json().catch(() => null)) as (Payload & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (!alive) return;
        setData(body);
        if (!since) setSince(body.filter.since);
        // A field the server did not keep (not in this city / range) goes back to All fields.
        if (field !== "all" && body.filter.field == null) setField("all");
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Failed to load"); }
    })();
    return () => { alive = false; };
  }, [token, query, since, field]);

  const reset = () => setPage(0);
  const downloadCsv = async () => {
    if (!token || busyCsv) return;
    setBusyCsv(true);
    try {
      const res = await fetch(query("&format=csv"), { headers: { Authorization: token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (res.headers.get("Content-Disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "churn.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(`CSV failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusyCsv(false); }
  };

  const message = async (id: number) => {
    if (!token) return;
    // Open the tab now, inside the click: a window opened after an await is blocked as a popup.
    const tab = window.open("about:blank", "_blank");
    setMsgState((m) => ({ ...m, [id]: "Opening…" }));
    try {
      const res = await fetch("/api/lifecycle/churn/message", { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ personId: id }) });
      const body = (await res.json().catch(() => ({}))) as { threadId?: string; created?: boolean; error?: string };
      if (!res.ok || !body.threadId) throw new Error(body.error ?? `HTTP ${res.status}`);
      const url = `/match-ops/player-chats?threadId=${encodeURIComponent(body.threadId)}`;
      if (tab) tab.location.href = url; else window.location.assign(url);
      setMsgState((m) => ({ ...m, [id]: body.created ? "Chat opened (new)" : "Chat opened" }));
    } catch (e) {
      tab?.close();
      setMsgState((m) => ({ ...m, [id]: `Couldn't open the chat: ${e instanceof Error ? e.message : String(e)}` }));
    }
  };

  const sortBy = (key: SortKey) => {
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" || key === "city" || key === "field" ? "asc" : "desc" }));
    reset();
  };

  if (error && !data) return <div className={`${g.stateMsg} ${g.errorMsg}`}>Could not load: {error}</div>;
  if (!data) return <div className={g.stateMsg}>Loading…</div>;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const cards: { key: Tier | null; label: string; value: number; foot: string }[] = [
    { key: null, label: "All stopped", value: data.counts.all, foot: "players" },
    ...TIERS.map((t) => ({ key: t, label: TIER_NAME[t], value: data.counts[t], foot: TIER_SUB[t] })),
  ];

  return (
    <>
      <div className={s.top}>
        <button type="button" className={s.btn} onClick={downloadCsv} disabled={busyCsv} data-testid="churn-csv">{busyCsv ? "Preparing…" : "Download CSV"}</button>
      </div>

      <section className={g.card} data-testid="churn-sentence">
        <div className={s.sentence}>
          <span>Players who haven&apos;t played in</span>
          <select className={s.sel} aria-label="Days gone" value={days} onChange={(e) => { setDays(Number(e.target.value)); reset(); }} data-testid="churn-days">
            {DAYS_OPTIONS.map((d) => <option key={d} value={d}>{daysLabel(d)}</option>)}
          </select>
          <span>but played since</span>
          <input type="date" className={s.sel} aria-label="Played since" value={since} max={data.today}
            onChange={(e) => { if (e.target.value) { setSince(e.target.value); reset(); } }} data-testid="churn-since" />
          <span>in</span>
          <select className={s.sel} aria-label="City" value={city} onChange={(e) => { setCity(e.target.value); setField("all"); reset(); }} data-testid="churn-city">
            <option value="all">All cities</option>
            {data.cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <span>at</span>
          <select className={s.sel} aria-label="Field" value={field} onChange={(e) => { setField(e.target.value); reset(); }} data-testid="churn-field">
            <option value="all">All fields</option>
            {data.fields.map((f) => <option key={f.key} value={String(f.key)}>{f.label}</option>)}
          </select>
          <span>.</span>
        </div>
        {!data.liveFieldsKnown && <div className={s.note} style={{ marginTop: 8 }}>Couldn&apos;t read MatchDay&apos;s live field list, so the field list shows every usual field in range.</div>}
      </section>

      <div className={s.cards} role="group" aria-label="Segments" data-testid="churn-cards">
        {cards.map((c) => (
          <button key={c.key ?? "all"} type="button" className={s.seg} aria-pressed={tier === c.key} onClick={() => { setTier(c.key); reset(); }} data-testid={`churn-card-${c.key ?? "all"}`}>
            <div className={s.segLabel}>{c.label}</div>
            <div className={s.segValue}>{int(c.value)}</div>
            <div className={s.segFoot}>{c.foot}</div>
          </button>
        ))}
      </div>

      <section className={g.card} data-testid="churn-table">
        {error && <div className={s.err}>{error}</div>}
        <div className={pa.tw}>
          <table>
            <thead>
              <tr>
                {data.columns.filter((c) => c.key !== "phone" && c.key !== "tags").map((c) => {
                  const sk = SORTABLE[c.key];
                  const on = sk && sort.key === sk;
                  return (
                    <th key={c.key} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                      {sk ? <button type="button" className={`${s.th} ${on ? s.thOn : ""}`} onClick={() => sortBy(sk)}>{c.label}{on ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</button> : c.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={8} className={s.note}>No one matches this filter.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.id} data-testid="churn-row">
                  <td>
                    <span className={s.name}>{r.name ?? `Player ${r.id}`}</span>
                    {r.everMember && <span className={s.tag}>Ex-member</span>}
                    {r.exManager && <span className={s.tag} title={`Managed ${int(r.managed)} matches (not counted as played)`}>Ex-manager</span>}
                    <span className={s.sub}>{r.phone ?? "No phone on file"}{r.managed > 0 ? ` · managed ${int(r.managed)}` : ""}</span>
                  </td>
                  <td>{r.cityName}</td>
                  <td>{r.field}</td>
                  <td>{int(r.matches)}</td>
                  <td>{money(r.spentCents)}</td>
                  <td>{dayLabel(r.last)}</td>
                  <td className={r.daysGone > DAYS_RED ? s.red : undefined}>{int(r.daysGone)}</td>
                  <td>
                    {r.winback.state === "came_back" ? <span className={s.pill}>Came back</span>
                      : r.winback.state === "messaged" ? <span className={s.pill}>Messaged {shortChicago(r.winback.at)}</span>
                      : <>
                          <button type="button" className={s.msg} disabled={!canMessage || !r.phone}
                            title={!canMessage ? "Needs Player Chats and SEND MESSAGES" : !r.phone ? "No phone on file" : "Open their WhatsApp chat in Player Chats"}
                            onClick={() => message(r.id)} data-testid="churn-message">Message</button>
                          {msgState[r.id] && <span className={s.sub}>{msgState[r.id]}</span>}
                        </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={s.foot}>
          <span>
            Sorted by {SORT_LABEL[sort.key]} · {int(data.total)} players
            {data.filter.field != null ? " · matches and spent at this field only" : ""}
            {data.excluded.formerStaff + data.excluded.deleted > 0
              ? ` · not listed: ${[data.excluded.formerStaff ? `${int(data.excluded.formerStaff)} former staff` : "", data.excluded.deleted ? `${int(data.excluded.deleted)} deleted accounts` : ""].filter(Boolean).join(", ")}`
              : ""}
          </span>
          <span className={s.pager}>
            <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹</button>
            Page {int(page + 1)} of {int(pages)}
            <button type="button" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>›</button>
          </span>
        </div>
        {data.refreshedAt && <div className={s.note}>Totals as of {new Date(data.refreshedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (rebuilt nightly).</div>}
      </section>
    </>
  );
}
