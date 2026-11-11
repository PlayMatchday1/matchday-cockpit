"use client";

/* FREE FIRST MATCH — the page body. Rebuilt 2026-11-08 to answer "is this working?" (Figma
 * sl6PTy5LhCVj1gF0HvGmuF frame 28:3; the 2026-11-05 version was frame 20794:45). Reads
 * /api/lifecycle/free-first-match once; the 7 / 14 / 30 day window re-reads it here.
 *
 * ONE WINDOW FOR EVERY RATE, and only players who have had the whole window count; the rest show as
 * "too early" (freeFirstMatchModel.ts, FAIR WINDOWS). The 2026-11-05 range and city controls, the
 * funnel and the members column were dropped with this design; the by-city table and the free match
 * log came back under it (Ryan, 2026-11-08), their rates on the same window.
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
import { useGrowth } from "./GrowthDataProvider";
import { normalizeMatchCity } from "@/lib/growthAnalytics";
import {
  WINDOWS, activation, beforePeople, byCity, firstAfterReadDay, freePeople, groupStats, logFields, logMatches, signupsSinceLaunch, soldOutByField,
  type FieldLoss, type Payload, type Window,
} from "@/lib/freeFirstMatchModel";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const pctOf = (r: number | null): string => (r == null ? "–" : `${Math.round(r * 100)}%`);
const money = (cents: number | null): string => (cents == null ? "–" : `$${Math.round(cents / 100).toLocaleString("en-US")}`);
const dash = "–";
/** "Oct 1" from a "YYYY-MM-DD" day. Never through Date: a day is a day in either clock. */
const dayLabel = (d: string): string => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

/** The free first match on a field's upcoming matches: On, Off, or how many of them are on. */
function ffeStatus(r: FieldLoss): { text: string; on: boolean } {
  if (r.upcoming === 0) return { text: "No upcoming", on: false };
  const known = r.upcoming - r.upcomingUnknown;
  if (known === 0) return { text: "Unknown", on: false };
  if (r.upcomingOn === r.upcoming) return { text: "On", on: true };
  if (r.upcomingOn === 0 && r.upcomingUnknown === 0) return { text: "Off", on: false };
  return { text: `On for ${r.upcomingOn} of ${r.upcoming}`, on: r.upcomingOn > 0 };
}

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
          App 1.89 made every new player&apos;s first match free, on iPhone and Android.
          <span className={s.tipTitle} style={{ marginTop: 8 }}>Sold out</span>
          A match is sold out when it is full at the field&apos;s max player spots (Field Ops). A match full at a smaller size
          could have been expanded, so it is shown as &ldquo;Full, can expand&rdquo; and its free spots aren&apos;t counted as lost.
          A field with no max set falls back to full at the match&apos;s own size, and is marked.
        </div>
      )}
    </>
  );
}

export default function FreeFirstMatchView({ authHeaders }: { authHeaders: Record<string, string> }) {
  /* By city lists every active city (growth_cities via /api/lifecycle, lib/activeCities), Philadelphia
   * included, plus any other city a free claimant played in. */
  const activeList = useGrowth().data?.activeCities;
  const activeCodes = useMemo(() => (activeList ?? []).flatMap((c) => (c.code ? [c.code] : [])), [activeList]);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [w, setW] = useState<Window>(7);
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

  const view = useMemo(() => {
    if (!data) return null;
    const t = data.today;
    const free = freePeople(data.people, t);
    const fs = groupStats(free, w, t);
    return {
      free, fs,
      act: activation(data.signups, w, t),
      signups: signupsSinceLaunch(data.signups, t),
      rows: [
        { key: "paid", title: "Paid first match (before Nov 5)", stats: groupStats(beforePeople(data.people, "paid"), w, t), hi: false, cost: false },
        { key: "code", title: "First-match codes", stats: groupStats(beforePeople(data.people, "code"), w, t), hi: false, cost: true },
        { key: "ref", title: "Referral codes", stats: groupStats(beforePeople(data.people, "ref"), w, t), hi: false, cost: true },
        { key: "free", title: "Free first match (since Nov 5)", stats: fs, hi: true, cost: true },
      ],
      lost: soldOutByField(data.matches, free, t),
      cities: byCity(free, w, t, normalizeMatchCity, activeCodes),
      logM: logMatches(data.matches, free, t),
      logF: logFields(free, w, t),
    };
  }, [data, w, activeCodes]);

  useEffect(() => { setShown(PAGE_FIRST); }, [logMode]);

  if (error) return <div className={`${g.stateMsg} ${g.errorMsg}`}>Could not load: {error}</div>;
  if (!data || !view) return <div className={g.stateMsg}>Loading…</div>;

  const { fs, act, lost } = view;
  const before = rate(act.before.played, act.before.done);
  const after = rate(act.after.played, act.after.done);
  const pts = before != null && after != null ? Math.round((after - before) * 1000) / 10 : null;
  const logRows = logMode === "matches" ? view.logM : view.logF;
  const visible = logRows.slice(0, shown);

  return (
    <>
      <div className={s.controls} data-testid="ffm-controls">
        <span className={s.ctlLabel}>Window</span>
        <div className={pa.seg} role="group" aria-label="Window">
          {WINDOWS.map((d) => (
            <button key={d} type="button" aria-pressed={w === d} onClick={() => setW(d)} data-testid={`ffm-w${d}`}>{d} days</button>
          ))}
        </div>
      </div>

      <section className={g.card} data-testid="ffm-activation">
        <div className={s.headTitle}>Are more new sign-ups playing their first match?</div>
        <div className={s.headRow}>
          <div className={s.side} data-testid="ffm-act-before">
            <div className={s.eyebrow}>4 weeks before Nov 5</div>
            <div className={s.big}>{pctOf(before)}</div>
            <div className={s.sideFoot}>of {fmtInt(act.before.done)} sign-ups ({dayLabel(act.before.from)} – {dayLabel(act.before.to)}) played within {w} days</div>
          </div>
          <div className={s.arrow} aria-hidden>→</div>
          <div className={s.side} data-testid="ffm-act-after">
            <div className={s.eyebrow}>Since Nov 5</div>
            {after == null ? (
              <>
                <div className={`${s.big} ${s.bigMuted}`}>Too early</div>
                <div className={s.sideFoot}>{fmtInt(act.after.signups)} sign-ups, none with {w} full days yet · first read {dayLabel(firstAfterReadDay(w))}</div>
              </>
            ) : (
              <>
                <div className={`${s.big} ${s.bigGreen}`}>{pctOf(after)}</div>
                <div className={s.sideFoot}>of {fmtInt(act.after.done)} sign-ups played within {w} days</div>
              </>
            )}
          </div>
          {pts != null && (
            <div className={s.delta}>
              <span className={`${s.pill} ${pts > 0 ? s.pillUp : pts < 0 ? s.pillDown : s.pillFlat}`} data-testid="ffm-act-delta">
                {pts > 0 ? "▲ +" : pts < 0 ? "▼ " : ""}{pts} pts
              </span>
              <span className={s.deltaFoot}>only sign-ups with {w} full days{act.after.tooEarly > 0 ? ` · ${fmtInt(act.after.tooEarly)} too early` : ""}</span>
            </div>
          )}
        </div>
      </section>

      <div className={g.kpiRow} data-testid="ffm-kpis">
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Free matches claimed</div>
          <div className={g.kpiValue} data-testid="ffm-claimed">{fmtInt(fs.players)}</div>
          <div className={g.kpiFoot}>{pctOf(rate(fs.players, view.signups))} of {fmtInt(view.signups)} sign-ups</div>
        </div>
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Paid 2nd match · {w}d</div>
          <div className={`${g.kpiValue} ${s.kpiInline}`}>
            <span data-testid="ffm-paid2nd">{fs.done > 0 ? pctOf(rate(fs.paid2nd, fs.done)) : dash}</span>
            {fs.tooEarly > 0 && <span className={`${s.pill} ${s.pillEarly}`}>{fmtInt(fs.tooEarly)} too early</span>}
          </div>
          <div className={g.kpiFoot}>{fs.done > 0 ? `${fmtInt(fs.paid2nd)} of ${fmtInt(fs.done)} players with ${w} days` : `No free player has had ${w} days yet`}</div>
        </div>
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Free spots given</div>
          <div className={g.kpiValue}>{money(fs.spotCents)}</div>
          <div className={g.kpiFoot}>{fmtInt(fs.players)} spots</div>
        </div>
        <div className={g.kpi}>
          <div className={g.kpiLabel}>Sold-out spots lost</div>
          <div className={g.kpiValue} data-testid="ffm-lost">{money(lost.cents)}</div>
          <div className={g.kpiFoot}>{fmtInt(lost.spots)} spots on {fmtInt(lost.matches)} sold-out matches</div>
          {lost.canExpand.matches > 0 && (
            <div className={g.kpiFoot} data-testid="ffm-can-expand">
              Not counted: {fmtInt(lost.canExpand.matches)} full {lost.canExpand.matches === 1 ? "match" : "matches"} under the field max ({fmtInt(lost.canExpand.freePlayers)} free {lost.canExpand.freePlayers === 1 ? "player" : "players"})
            </div>
          )}
        </div>
      </div>

      <section className={g.card} data-testid="ffm-before-after">
        <div className={g.cardHead}>
          <div>
            <div className={g.cardTitle}>Before vs after, same {w}-day window</div>
            <div className={g.cardSub}>Players who haven&apos;t had {w} days yet are counted as &ldquo;too early&rdquo;, not as failures. Before = first match Aug 7 – Nov 4.</div>
          </div>
        </div>
        <div className={pa.tw}>
          <table>
            <thead>
              <tr><th>First match</th><th>Players</th><th>2nd match · {w}d</th><th>3rd match · {w}d</th><th>Too early</th><th>Cost per payer</th></tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.key} className={r.hi ? s.hiGreen : undefined} data-testid={`ffm-row-${r.key}`}>
                  <td><span className={s.rowTitle}>{r.title}</span></td>
                  <td>{fmtInt(r.stats.players)}</td>
                  <td>{pctOf(rate(r.stats.paid2nd, r.stats.done))}</td>
                  <td>{pctOf(rate(r.stats.paid3rd, r.stats.done))}</td>
                  <td>{r.hi && r.stats.tooEarly > 0 ? <span className={`${s.pill} ${s.pillEarly}`}>{fmtInt(r.stats.tooEarly)}</span> : fmtInt(r.stats.tooEarly)}</td>
                  <td>{r.cost ? money(r.stats.costPerPayerCents) : dash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={g.card} data-testid="ffm-sold-out">
        <div className={g.cardHead}>
          <div>
            <div className={g.cardTitle}>Where free players took sold-out spots</div>
            <div className={g.cardSub}>Matches since Nov 5 with a free player in them that are sold out: full at the field&apos;s max player spots (Field Ops). Full but under that max is counted under Full, can expand, not as lost. Free match = the switch on the field&apos;s upcoming matches.</div>
          </div>
        </div>
        {lost.rows.length === 0 ? (
          <div className={s.empty}>No full match has a free player in it yet.</div>
        ) : (
          <div className={pa.tw}>
            <table>
              <thead><tr><th>Field</th><th>City</th><th>Field max</th><th>Sold out w/ free</th><th>Spots lost</th><th>Lost $</th><th>Full, can expand</th><th>Free match</th></tr></thead>
              <tbody>
                {lost.rows.map((r) => {
                  const st = ffeStatus(r);
                  return (
                    <tr key={`${r.city}|${r.field}`}>
                      <td><span className={s.rowTitle}>{r.field}</span></td>
                      <td>{r.cityName}</td>
                      <td>{r.fieldMax != null ? fmtInt(r.fieldMax)
                        : <span className={s.noMax} data-testid="ffm-no-field-max" title="No max player spots set on Field Ops for this field, so a match full at its own size counts as sold out here. Set it on Field Ops.">No max set</span>}</td>
                      <td>{fmtInt(r.soldOutWithFree)}</td>
                      <td>{fmtInt(r.spotsLost)}</td>
                      <td>{money(r.centsLost)}</td>
                      <td>{r.fullCanExpand > 0 ? fmtInt(r.fullCanExpand) : dash}</td>
                      <td><span className={`${s.pill} ${st.on ? s.pillOn : s.pillOff}`} title={`${r.upcomingOn} of ${r.upcoming} upcoming matches on`}>{st.text}</span></td>
                    </tr>
                  );
                })}
                <tr className={s.totRow}>
                  <td>All fields</td><td /><td />
                  <td>{fmtInt(lost.matches)}</td><td>{fmtInt(lost.spots)}</td><td>{money(lost.cents)}</td><td>{fmtInt(lost.canExpand.matches)}</td><td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={g.card} data-testid="ffm-by-city">
        <div className={g.cardHead}>
          <div>
            <div className={g.cardTitle}>By city</div>
            <div className={g.cardSub}>Free first matches since Nov 5, by the city of the match. 2nd match on the same {w}-day window.</div>
          </div>
        </div>
        <div className={pa.tw}>
          <table>
            <thead><tr><th>City</th><th>Claimed</th><th>2nd match · {w}d</th><th>Too early</th><th>Cost per payer</th></tr></thead>
            <tbody>
              {view.cities.map((c) => (
                <tr key={c.city}>
                  <td>{c.cityName}</td>
                  <td className={c.stats.players === 0 ? pa.zero : undefined}>{fmtInt(c.stats.players)}</td>
                  <td>{pctOf(rate(c.stats.paid2nd, c.stats.done))}</td>
                  <td>{fmtInt(c.stats.tooEarly)}</td>
                  <td>{money(c.stats.costPerPayerCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={g.card} data-testid="ffm-log">
        <div className={g.cardHead}>
          <div className={g.cardTitle}>Free match log</div>
          <div className={pa.seg} role="group" aria-label="Log view">
            <button type="button" aria-pressed={logMode === "matches"} onClick={() => setLogMode("matches")}>Matches</button>
            <button type="button" aria-pressed={logMode === "fields"} onClick={() => setLogMode("fields")}>Fields</button>
          </div>
        </div>
        {logRows.length === 0 ? (
          <div className={s.empty}>No free first matches yet.</div>
        ) : logMode === "matches" ? (
          <table className={s.logTable}>
            <thead><tr><th>Match</th><th>Free players</th><th>Booked</th></tr></thead>
            <tbody>
              {(visible as typeof view.logM).map((m) => (
                <tr key={m.id}>
                  <td><span className={s.matchName}>{m.field} · {m.cityName}</span><span className={s.matchWhen}>{whenLabel(m.wall)}</span></td>
                  <td><div className={s.chips}>{m.freePlayers.map((p) => <span key={p.id} className={s.chip}>{p.name}</span>)}</div></td>
                  <td>
                    {m.capacity === "sold_out" && <span className={s.soldOut} title={`Full at the field max of ${m.fieldMax}`}>Sold out</span>}
                    {m.capacity === "sold_out_no_field_max" && <span className={s.soldOut} title="Full at its own size; the field has no max set on Field Ops">Sold out · no field max</span>}
                    {m.capacity === "full_can_expand" && <span className={s.canExpand} title={`Full at ${m.cap}, under the field max of ${m.fieldMax}: not counted as lost`}>Full, can expand</span>}
                    <span className={s.booked}>{fmtInt(m.booked)} / {m.cap == null ? dash : fmtInt(m.cap)}</span>
                    {m.fieldMax != null && m.cap != null && m.fieldMax > m.cap && <span className={s.matchWhen}>field max {fmtInt(m.fieldMax)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className={s.logTable}>
            <thead><tr><th>Field · City</th><th className={s.num}>Free players</th><th className={s.num}>Matches</th><th className={s.num}>Paid 2nd · {w}d</th></tr></thead>
            <tbody>
              {(visible as typeof view.logF).map((f) => (
                <tr key={`${f.city}|${f.field}`}>
                  <td><span className={s.matchName}>{f.field} · {f.cityName}</span></td>
                  <td className={s.num}>{fmtInt(f.stats.players)}</td>
                  <td className={s.num}>{fmtInt(f.matches)}</td>
                  <td className={s.num}>{f.stats.done > 0 ? pctOf(rate(f.stats.paid2nd, f.stats.done)) : `${fmtInt(f.stats.tooEarly)} too early`}</td>
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
