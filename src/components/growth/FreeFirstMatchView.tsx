"use client";

/* FREE FIRST MATCH — the page body (Ryan, 2026-11-05; Figma "Clubhouse · Free First Match",
 * frame 20794:45). Reads /api/lifecycle/free-first-match once and filters it here: the range is the
 * day of the player's free match, the city is the city of that match. The before groups keep their
 * fixed window and follow only the city.
 *
 * NO PLATFORM TOGGLE AND NO BLOCKED-CLAIMS CARD. Neither is tracked anywhere the Clubhouse reads
 * (docs/free-first-match/DISCOVERY.md §3 and §4); the backend asks are recorded there, not here.
 *
 * Cards, the KPI grid and the segmented toggle are the Player Lifecycle's own classes; the tooltip
 * is Player Activity's. freeFirstMatch.module.css carries only what those two do not have.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import g from "./growth.module.css";
import pa from "./playerActivity.module.css";
import s from "./freeFirstMatch.module.css";
import { fmtInt } from "./format";
import { CITY_SCOPES } from "@/lib/cityScope";
import { normalizeMatchCity } from "@/lib/growthAnalytics";
import {
  LAUNCH_DAY, beforePeople, byCity, freePeople, groupStats, logFields, logMatches, matchesInRange, paidSpots, registrations,
  type Filter, type Payload,
} from "@/lib/freeFirstMatchModel";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pct = (num: number, den: number): string => (den > 0 ? `${Math.round((num / den) * 100)}%` : "–");
const money = (cents: number | null): string => (cents == null ? "–" : `$${Math.round(cents / 100).toLocaleString("en-US")}`);
const dash = "–";

/** "Thu Dec 4 · 9:00 PM" from a wall-clock "YYYY-MM-DDTHH:MM". No Date is built from the string:
 *  the Z the mirror carries is not meant (docs, "Match startDate/endDate are LOCAL WALL CLOCK"). */
function whenLabel(wall: string): string {
  const [d, t] = wall.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  const [hh, mm] = (t ?? "00:00").split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${dow} ${MON[m - 1]} ${dd} · ${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

const PAGE_FIRST = 6;
const PAGE_MORE = 20;

export function FreeFirstMatchInfo() {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const show = useCallback((el: HTMLElement) => { const r = el.getBoundingClientRect(); setOpen({ x: r.left + r.width / 2, y: r.bottom + 8 }); }, []);
  const hide = useCallback(() => setOpen(null), []);
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <>
      <span className={pa.info} tabIndex={0} role="button" aria-label="About this page" data-testid="ffm-info"
        onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)} onBlur={hide}
        onClick={(e) => { e.stopPropagation(); open ? hide() : show(e.currentTarget); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open ? hide() : show(e.currentTarget); } }}
      >i</span>
      {open && (
        <div className={pa.tip} role="tooltip" style={{ left: open.x, top: open.y, maxWidth: 300 }}>
          <span className={s.tipTitle}>Started Nov 5, 2026</span>
          App 1.89 made every new player&apos;s first match free.
        </div>
      )}
    </>
  );
}

export default function FreeFirstMatchView({ authHeaders }: { authHeaders: Record<string, string> }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(LAUNCH_DAY);
  const [end, setEnd] = useState("");
  const [city, setCity] = useState<string>("all");
  const [logMode, setLogMode] = useState<"matches" | "fields">("matches");
  const [shown, setShown] = useState(PAGE_FIRST);

  const token = authHeaders.Authorization;
  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/lifecycle/free-first-match", { headers: { Authorization: token } });
        const body = (await res.json().catch(() => null)) as (Payload & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (alive) setData(body);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Failed to load"); }
    })();
    return () => { alive = false; };
  }, [token]);

  const today = data?.today ?? "";
  const filter = useMemo<Filter>(() => {
    const a = start || LAUNCH_DAY, b = end || today || LAUNCH_DAY;
    return { start: a <= b ? a : b, end: a <= b ? b : a, city };
  }, [start, end, today, city]);

  /* The city list: the running cities, plus any other city a free match or a live match carries, so
   * nothing is hidden behind a list written before it opened. */
  const cityCodes = useMemo(() => {
    const codes = new Set<string>(CITY_SCOPES.map((c) => c.identifier));
    for (const p of data?.people ?? []) if (p.group === "free" && p.city) codes.add(p.city);
    for (const m of data?.matches ?? []) if (m.city) codes.add(m.city);
    return [...codes].sort((a, b) => normalizeMatchCity(a).localeCompare(normalizeMatchCity(b)));
  }, [data]);

  const view = useMemo(() => {
    if (!data) return null;
    const free = freePeople(data.people, filter);
    const freeIds = new Set(free.map((p) => p.id));
    const stats = groupStats(free);
    const regs = registrations(data.regs, filter, normalizeMatchCity);
    const ms = matchesInRange(data.matches, filter);
    return {
      free, stats, regs,
      rows: [
        { key: "paid", title: "Paid first match", sub: "Before Nov 5", stats: groupStats(beforePeople(data.people, "paid", filter)), hi: false, cost: false },
        { key: "code", title: "First-match codes", sub: "Marketing codes, still live", stats: groupStats(beforePeople(data.people, "code", filter)), hi: false, cost: true },
        { key: "ref", title: "Referral codes", sub: "Friend invites", stats: groupStats(beforePeople(data.people, "ref", filter)), hi: false, cost: true },
        { key: "free", title: "Free first match", sub: "Automatic since Nov 5", stats, hi: true, cost: true },
      ],
      cities: byCity(free, normalizeMatchCity, CITY_SCOPES.map((c) => c.identifier)),
      spots: paidSpots(ms, freeIds),
      logM: logMatches(ms, freeIds),
      logF: logFields(free),
    };
  }, [data, filter]);

  useEffect(() => { setShown(PAGE_FIRST); }, [filter, logMode]);

  if (error) return <div className={`${g.stateMsg} ${g.errorMsg}`}>Could not load: {error}</div>;
  if (!data || !view) return <div className={g.stateMsg}>Loading…</div>;

  const { stats, regs, spots } = view;
  const funnel = [
    { label: "Booked free match", n: stats.players, hue: "#0d3b2e" },
    { label: "Paid 2nd match", n: stats.paid2nd, hue: "#186b4c" },
    { label: "Paid 3rd match", n: stats.paid3rd, hue: "#4b7d66" },
    { label: "Became member", n: stats.members, hue: "#6f9a85" },
  ];
  const logRows = logMode === "matches" ? view.logM : view.logF;
  const visible = logRows.slice(0, shown);

  return (
    <>
      <div className={s.controls} data-testid="ffm-controls">
        <select className={s.select} aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} data-testid="ffm-city">
          <option value="all">All cities</option>
          {cityCodes.map((c) => <option key={c} value={c}>{normalizeMatchCity(c)}</option>)}
        </select>
        <span className={s.rangeLabel}>Range</span>
        <input type="date" className={s.date} aria-label="Range start" value={filter.start} max={today || undefined}
          onChange={(e) => setStart(e.target.value)} data-testid="ffm-start" />
        <span className={s.to}>to</span>
        <input type="date" className={s.date} aria-label="Range end" value={filter.end} max={today || undefined}
          onChange={(e) => setEnd(e.target.value)} data-testid="ffm-end" />
      </div>

      <div className={g.kpiRow} data-testid="ffm-kpis">
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Free matches claimed</div>
          <div className={g.kpiValue} data-testid="ffm-claimed">{fmtInt(stats.players)}</div>
          <div className={g.kpiFoot}>{pct(stats.players, regs)} of {fmtInt(regs)} new sign-ups</div>
        </div>
        <div className={`${g.kpi} ${s.kpiDark}`}>
          <div className={`${g.kpiLabel} ${s.kpiLabelDark}`}>Paid 2nd match</div>
          <div className={`${g.kpiValue} ${s.kpiValueDark}`}>{pct(stats.paid2nd, stats.players)}</div>
          <div className={`${g.kpiFoot} ${s.kpiFootDark}`}>{fmtInt(stats.paid2nd)} players within 30 days</div>
        </div>
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Became members</div>
          <div className={g.kpiValue}>{pct(stats.members, stats.players)}</div>
          <div className={g.kpiFoot}>{fmtInt(stats.members)} players within 60 days</div>
        </div>
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Cost per paying player</div>
          <div className={g.kpiValue}>{money(stats.costPerPayerCents)}</div>
          <div className={g.kpiFoot}>{money(stats.spotCents)} in free spots</div>
        </div>
      </div>

      <section className={g.card} data-testid="ffm-funnel">
        <div className={g.cardHead}>
          <div className={g.cardTitle}>Funnel</div>
          <div className={s.cardMeta}>{fmtInt(regs)} new sign-ups · {pct(stats.players, regs)} booked their free match</div>
        </div>
        <div className={s.funnel}>
          {funnel.map((f) => (
            <div className={s.funnelRow} key={f.label}>
              <div className={s.funnelLabel}>{f.label}</div>
              <div className={s.funnelTrack}>
                <div className={s.funnelBar} style={{ width: stats.players > 0 ? `${Math.max(0, Math.min(100, (f.n / stats.players) * 100))}%` : "0%", background: f.hue }} />
              </div>
              <div className={s.funnelNum}>{fmtInt(f.n)}<span className={s.funnelPct}>{pct(f.n, stats.players)}</span></div>
            </div>
          ))}
        </div>
      </section>

      <section className={g.card} data-testid="ffm-before-after">
        <div className={g.cardHead}>
          <div className={g.cardTitle}>Before vs after</div>
          <div className={s.cardMeta}>Grouped by how the player got their first match</div>
        </div>
        <div className={pa.tw}>
          <table>
            <thead>
              <tr><th>First match</th><th>Players</th><th>2nd match · 30d</th><th>3rd match</th><th>Member · 60d</th><th>Cost per payer</th></tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.key} className={r.hi ? s.hiGreen : undefined} data-testid={`ffm-row-${r.key}`}>
                  <td><span className={s.rowTitle}>{r.title}</span><span className={s.rowSub}>{r.sub}</span></td>
                  <td>{fmtInt(r.stats.players)}</td>
                  <td>{pct(r.stats.paid2nd, r.stats.players)}</td>
                  <td>{pct(r.stats.paid3rd, r.stats.players)}</td>
                  <td>{pct(r.stats.members, r.stats.players)}</td>
                  <td>{r.cost ? money(r.stats.costPerPayerCents) : dash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={g.grid2}>
        <section className={g.card} data-testid="ffm-by-city">
          <div className={g.cardHead}><div className={g.cardTitle}>By city</div></div>
          <div className={pa.tw}>
            <table>
              <thead><tr><th>City</th><th>Claimed</th><th>2nd match</th><th>Cost per payer</th></tr></thead>
              <tbody>
                {view.cities.map((c) => (
                  <tr key={c.city}>
                    <td>{c.cityName}</td>
                    <td className={c.claimed === 0 ? pa.zero : undefined}>{fmtInt(c.claimed)}</td>
                    <td>{pct(c.paid2nd, c.claimed)}</td>
                    <td>{money(c.costPerPayerCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={g.card} data-testid="ffm-paid-spots">
          <div className={g.cardHead}><div className={g.cardTitle}>Paid spots taken</div></div>
          <div className={s.stat}><span>Matches with a free player</span><b>{fmtInt(spots.matchesWithFree)}</b></div>
          <div className={s.stat}><span>Sold out with a free player in it</span><b>{fmtInt(spots.soldOutWithFree)}</b></div>
          <div className={`${s.stat} ${s.statGold}`}><span>Spots a paying player could have had</span><b>{fmtInt(spots.spotsLost)} · {money(spots.spotsLostCents)}</b></div>
          <div className={s.subhead}>Average fill</div>
          <div className={s.fillRow}><span>With a free player</span><b>{spots.fillWithFree == null ? dash : `${Math.round(spots.fillWithFree * 100)}%`}</b></div>
          <div className={s.fillRow}><span>Without</span><b>{spots.fillWithout == null ? dash : `${Math.round(spots.fillWithout * 100)}%`}</b></div>
        </section>
      </div>

      <section className={g.card} data-testid="ffm-log">
        <div className={g.cardHead}>
          <div className={g.cardTitle}>Free match log</div>
          <div className={pa.seg} role="group" aria-label="Log view">
            <button type="button" aria-pressed={logMode === "matches"} onClick={() => setLogMode("matches")}>Matches</button>
            <button type="button" aria-pressed={logMode === "fields"} onClick={() => setLogMode("fields")}>Fields</button>
          </div>
        </div>
        {logRows.length === 0 ? (
          <div className={s.empty}>No free first matches in this range.</div>
        ) : logMode === "matches" ? (
          <table className={s.logTable}>
            <thead><tr><th>Match</th><th>Free players</th><th>Booked</th></tr></thead>
            <tbody>
              {(visible as typeof view.logM).map((m) => (
                <tr key={m.id}>
                  <td><span className={s.matchName}>{m.field} · {m.cityName}</span><span className={s.matchWhen}>{whenLabel(m.wall)}</span></td>
                  <td><div className={s.chips}>{m.freePlayers.map((p) => <span key={p.id} className={s.chip}>{p.name}</span>)}</div></td>
                  <td>
                    {m.soldOut && <span className={s.soldOut}>Sold out</span>}
                    <span className={s.booked}>{fmtInt(m.booked)} / {m.cap == null ? dash : fmtInt(m.cap)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className={s.logTable}>
            <thead><tr><th>Field · City</th><th className={s.num}>Free players</th><th className={s.num}>Matches</th><th className={s.num}>Paid 2nd match</th></tr></thead>
            <tbody>
              {(visible as typeof view.logF).map((f) => (
                <tr key={`${f.city}|${f.field}`}>
                  <td><span className={s.matchName}>{f.field} · {f.cityName}</span></td>
                  <td className={s.num}>{fmtInt(f.freePlayers)}</td>
                  <td className={s.num}>{fmtInt(f.matches)}</td>
                  <td className={s.num}>{pct(f.paid2nd, f.freePlayers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {logRows.length > shown && (
          <button type="button" className={s.more} onClick={() => setShown((n) => n + PAGE_MORE)}>
            Show {fmtInt(Math.min(PAGE_MORE, logRows.length - shown))} more
          </button>
        )}
      </section>
    </>
  );
}
