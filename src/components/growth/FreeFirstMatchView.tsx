"use client";

/* FREE FIRST MATCH — the page body. Redesign 2026-11-21 (Figma 9TgSk4sYqq4nNoTH73wRRs frame 21615:72):
 * "Is giving the first match away worth it?" Header pickers (range, city), a one-line verdict written from
 * the numbers, four tiles, how cost is counted, the fields that sell out (with each field's Free Match
 * switch), free vs paid first-timers, and a watch list. Every number is the server's
 * (GET /api/lifecycle/free-first-match, freeFirstMatchModel.ts summarize); this file only draws it.
 *
 * THE FIELD SWITCH writes the match's own firstMatchFreeEnabled on each upcoming match of the field, one at
 * a time, through the Match panel's route (src/lib/ffmFieldSwitch.ts). Admins only (the route refuses
 * anyone else; the greyed switch is courtesy). Nothing retries; the first match that does not land stops it.
 *
 * Removed with the redesign (Ryan, 2026-11-21): the 7/14/30 window toggle, the activation headline, the
 * free spots given total, the by-city table and the free match log. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import pa from "./playerActivity.module.css";
import s from "./freeFirstMatch.module.css";
import { Btn, O, Toggle } from "@/components/offers/offersUi";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import { addDays } from "@/lib/weekBuckets";
import { LAUNCH_DAY, rateWithRange, type FieldRow, type Rate, type View } from "@/lib/freeFirstMatchModel";
import { GAP_MS, matchesToChange, runFieldSwitch, type SwitchStep } from "@/lib/ffmFieldSwitch";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Oct 22" from "YYYY-MM-DD". Never through Date: a day is a day. */
const dayLabel = (d: string): string => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
/** "Oct 22 – Nov 4", or "Nov 5 – 18" within one month. */
const spanLabel = (a: string, b: string): string => (a.slice(0, 7) === b.slice(0, 7) ? `${dayLabel(a)} – ${Number(b.slice(8, 10))}` : `${dayLabel(a)} – ${dayLabel(b)}`);
/** "Thu Dec 4, 9:00 PM" from a wall-clock "YYYY-MM-DDTHH:MM" (the Z the mirror carries is not meant). */
function whenLabel(wall: string): string {
  const [d, t] = wall.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  const [hh, mm] = (t ?? "00:00").split(":").map(Number);
  return `${dow} ${MON[m - 1]} ${dd}, ${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
const dollars = (cents: number | null): string => (cents == null ? "—" : `$${Math.round(cents / 100).toLocaleString("en-US")}`);
const dollars2 = (cents: number | null): string => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);
const pct = (x: number | null): string => (x == null ? "—" : `${Math.round(x * 100)}%`);
const n = (x: number): string => x.toLocaleString("en-US");

export type Preset = "launch" | "14" | "7";
export const PRESETS: { key: Preset; label: string }[] = [
  { key: "launch", label: "Since launch" }, { key: "14", label: "Last 14 days" }, { key: "7", label: "Last 7 days" },
];
/** The range a preset asks for, from the server's today. "Since launch" sends nothing (the server's default). */
function rangeOf(preset: Preset, today: string | null): { from?: string; to?: string } {
  if (preset === "launch" || !today) return {};
  const to = addDays(today, -1);
  let from = addDays(to, -(Number(preset) - 1));
  if (from < LAUNCH_DAY) from = LAUNCH_DAY;
  return { from, to };
}

const TOP = 8;

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
        <div className={pa.tip} role="tooltip" style={{ left: open.x, top: open.y, maxWidth: 320 }}>
          <span className={s.tipTitle}>Who counts</span>
          Real players only, their own spot, not left or refunded, on matches that were played. Warsaw, New York City and El Paso are left out.
          <span className={s.tipTitle} style={{ marginTop: 8 }}>Sold out</span>
          Full at the field&apos;s max player spots (Field Ops). A field with no max set falls back to full at the match&apos;s own size, and is marked.
          <span className={s.tipTitle} style={{ marginTop: 8 }}>Money</span>
          Card dollars actually charged, minus refunds; wallet credit is not added. A partly refunded booking counts as fully refunded.
        </div>
      )}
    </>
  );
}

/** The range and city pickers, in the title row. */
export function FreeFirstMatchControls({ preset, setPreset, city, setCity, cities }: {
  preset: Preset; setPreset: (p: Preset) => void; city: string; setCity: (c: string) => void; cities: { code: string; name: string }[];
}) {
  return (
    <div className={s.controls}>
      <label className={s.pickWrap}>
        <select className={s.pick} aria-label="Date range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="ffm-range">
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </label>
      <label className={s.pickWrap}>
        <select className={s.pick} aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} data-testid="ffm-city">
          <option value="">All cities</option>
          {cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      </label>
    </div>
  );
}

type Pending = { row: FieldRow; value: boolean; targets: { id: number; wall: string }[]; steps: SwitchStep[] | null; running: boolean };

export default function FreeFirstMatchView({ authHeaders, preset, city, onCities }: {
  authHeaders: Record<string, string>; preset: Preset; city: string; onCities: (c: { code: string; name: string }[]) => void;
}) {
  const { appUser } = useAuth();
  const mayWrite = appUser?.is_admin === true && canEditMatches(appUser);
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /* The server's today, learned from the first answer: a ref, so learning it never triggers a re-fetch. */
  const today = useRef<string | null>(null);
  /* Set after a field switch: the next request rebuilds the base once (fresh=1), then never again. */
  const fresh = useRef(false);
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reload, setReload] = useState(0);
  const token = authHeaders.Authorization;

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const q = new URLSearchParams();
        const r = rangeOf(preset, today.current);
        if (r.from) q.set("from", r.from);
        if (r.to) q.set("to", r.to);
        if (city) q.set("city", city);
        if (fresh.current) { q.set("fresh", "1"); fresh.current = false; }
        const res = await fetch(`/api/lifecycle/free-first-match?${q}`, { headers: { Authorization: token }, cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (View & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (!alive) return;
        setData(body); setError(null);
        if (!today.current) today.current = body.today;
        onCities(body.cities);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Failed to load"); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, preset, city, reload]);

  const rows = useMemo(() => (data ? (showAll ? data.fields : data.fields.slice(0, TOP)) : []), [data, showAll]);

  const ask = (row: FieldRow, value: boolean) => {
    const targets = matchesToChange(row.upcoming, value).map((u) => ({ id: u.id, wall: u.wall }));
    if (targets.length === 0) return;
    setPending({ row, value, targets, steps: null, running: false });
  };

  const run = async () => {
    if (!pending || pending.running || pending.steps) return;
    setPending((p) => (p ? { ...p, running: true } : p));
    const steps = await runFieldSwitch({
      matches: pending.targets, value: pending.value,
      put: async (id, body) => {
        const res = await fetch(`/api/matchday/prod/matches/${id}`, { method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onStep: (st) => setPending((p) => (p ? { ...p, steps: st } : p)),
    });
    // Paint what LANDED now; the base is rebuilt when the dialog closes, so everything else re-reads.
    const landed = new Set(steps.filter((x) => x.state === "landed").map((x) => x.id));
    setData((d) => d && {
      ...d,
      fields: d.fields.map((f) => f.key !== pending.row.key ? f : { ...f, upcoming: f.upcoming.map((u) => (landed.has(u.id) ? { ...u, ffe: pending.value } : u)) }),
    });
    setPending((p) => (p ? { ...p, running: false, steps } : p));
  };

  const close = () => {
    if (pending?.running) return;
    const wrote = pending?.steps?.some((x) => x.state !== "not_sent" && x.state !== "waiting");
    setPending(null);
    if (wrote) { fresh.current = true; setReload((x) => x + 1); }
  };

  if (error && !data) return <div className={s.note}>Could not load: {error}</div>;
  if (!data) return <div className={s.note}>Loading…</div>;

  const v = data;
  const vTone = v.verdict.tone === "good" ? s.vGood : v.verdict.tone === "warn" ? s.vWarn : v.verdict.tone === "bad" ? s.vBad : s.vMuted;
  const vPill = v.verdict.tone === "good" ? s.pWhiteGreen : v.verdict.tone === "warn" ? s.pWhiteAmber : s.pWhite;
  const ch = v.newPerDay.changePct;
  const diff = v.came7.diffPts;
  const cmp = v.came7.compare;
  const daysWord = `${v.range.days} days`;
  /* THE 95% RANGES, ON HOVER (Ryan, 2026-11-21). Better or worse is called only when they do not overlap. */
  const rangeTip = `Came back and paid in 7 days, with 95% ranges:\n` +
    `Free since ${dayLabel(v.range.from)}: ${rateWithRange(v.came7.free)}, ${n(v.came7.free.judged)} judged\n` +
    `Paid first-timers before: ${rateWithRange(v.came7.paid)}, ${n(v.came7.paid.judged)} judged\n` +
    `Code users before: ${rateWithRange(v.came7.code)}, ${n(v.came7.code.judged)} judged\n` +
    (cmp == null ? "Not enough players to compare yet."
      : cmp === "same" ? "The free and paid ranges overlap, so the difference could be chance: same as paid."
      : "The free and paid ranges do not overlap.");

  return (
    <div className={s.root} style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s" }} data-testid="ffm-root">
      {error && <div className={s.note}>Could not refresh: {error}</div>}

      <div className={`${s.verdict} ${vTone}`} data-testid="ffm-verdict" title={rangeTip}>
        <span className={`${s.pill} ${vPill}`}>{v.verdict.label}</span>
        <span>{v.verdict.text}</span>
      </div>

      <div className={s.tiles} data-testid="ffm-tiles">
        <div className={s.tile}>
          <div className={s.tLabel}>New first-timers a day</div>
          <div className={s.tValue} data-testid="ffm-new-per-day">{v.newPerDay.after.toFixed(1)}</div>
          <div className={s.tFoot}>{v.newPerDay.before.toFixed(1)} a day in the {daysWord} before ({spanLabel(v.before.from, v.before.to)})</div>
          {ch != null && <span className={`${s.pill} ${ch >= 0 ? s.pGreen : s.pRed}`} data-testid="ffm-new-change">{ch >= 0 ? "+" : ""}{Math.round(ch * 100)}%</span>}
        </div>
        <div className={s.tile}>
          <div className={s.tLabel}>Came back and paid in 7 days</div>
          <div className={s.tValue} data-testid="ffm-came7" title={rangeTip}>{pct(v.came7.free.pct)}</div>
          <div className={s.tFoot}>Paid first-timers before: {pct(v.came7.paid.pct)}. Code users: {pct(v.came7.code.pct)}.</div>
          {cmp != null && diff != null && (
            <span className={`${s.pill} ${cmp === "worse" ? s.pAmber : s.pGreen}`} title={rangeTip} style={{ cursor: "help" }} data-testid="ffm-came7-compare">
              {cmp === "same" ? "Same as paid" : cmp === "better" ? `${Math.abs(diff)} pts above paid` : `${Math.abs(diff)} pts below paid`}
            </span>
          )}
          {v.came7.free.judged < v.came7.free.players && <span className={s.tFoot}>{n(v.came7.free.judged)} of {n(v.came7.free.players)} free players have had 7 days</span>}
        </div>
        <div className={s.tile}>
          <div className={s.tLabel}>Paid back so far</div>
          <div className={s.tValue} data-testid="ffm-paid-back">{dollars(v.paidBack.cents)}</div>
          <div className={s.tFoot}>From {n(v.paidBack.spenders)} of {n(v.paidBack.players)} free players</div>
          <div className={s.tLine}><b>{n(v.paidBack.paidMatches)}</b><span>paid matches after their free one</span></div>
          <span className={`${s.pill} ${s.pGrey}`}>Grows each week</span>
        </div>
        <div className={`${s.tile} ${s.tileAmber}`}>
          <div className={s.tLabel}>Lost on sold-out matches</div>
          <div className={`${s.tValue} ${s.tValueAmber}`} data-testid="ffm-lost">{dollars(v.lost.cents)}</div>
          <div className={s.tFoot}>{n(v.lost.spots)} free first-match spots, incl. codes, on full matches. Someone would have paid for these.</div>
          {v.lost.noMaxMatches > 0 && <div className={s.tFoot}>{n(v.lost.noMaxMatches)} of these matches are on fields with no max set, judged full at their own size.</div>}
          <span className={`${s.pill} ${s.pWhiteAmber}`}>{dollars(v.lost.perWeekCents)} a week</span>
        </div>
      </div>

      <div className={s.explain} data-testid="ffm-explain">
        How we count cost: a free spot on a match with room costs nothing, the seat would be empty. A free spot on a sold-out match is lost revenue
        {v.refill.leaves > 0 ? <>: when a spot opens up on one, someone buys it ({n(v.refill.refilled)} of {n(v.refill.leaves)} times).</> : "."}
      </div>

      <section className={s.section} data-testid="ffm-fields">
        <div className={s.secHead}>
          <div>
            <div className={s.secTitle}>Where it costs us: fields that sell out</div>
            <div className={s.secSub}>Sorted by money lost. Turn the free match off where a field usually sells out.</div>
          </div>
          <div className={s.grow} />
          {v.suggestedOff > 0 && <span className={`${s.pill} ${s.pAmber}`} data-testid="ffm-suggested">Suggested off: {n(v.suggestedOff)} {v.suggestedOff === 1 ? "field" : "fields"}</span>}
        </div>
        {v.fields.length === 0 ? <div className={s.note}>No matches in this range.</div> : (
          <div className={s.tableWrap}>
            <table className={s.fields}>
              <thead>
                <tr>
                  <th>Field</th><th style={{ width: 110 }}>City</th><th style={{ width: 130 }}>Sold out</th><th style={{ width: 120 }}>Free on full</th>
                  <th style={{ width: 100 }}>Lost</th><th style={{ width: 100 }} title="Card dollars the field's free first-timers have spent on other matches since">Paid back</th><th style={{ width: 190 }}>Free match</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <FieldTr key={r.key} r={r} cityName={v.cities.find((c) => c.code === r.city)?.name ?? r.city} mayWrite={mayWrite} onSwitch={ask} />)}
              </tbody>
            </table>
          </div>
        )}
        {v.fields.length > TOP && (
          <button type="button" className={s.more} onClick={() => setShowAll((x) => !x)} data-testid="ffm-show-all">
            {showAll ? "Show top 8" : `Show all ${n(v.fields.length)} fields`}
          </button>
        )}
      </section>

      <section className={s.section} data-testid="ffm-cohorts">
        <div>
          <div className={s.secTitle}>Free players vs players who paid for their first match</div>
          <div className={s.secSub}>Same-length windows: {spanLabel(v.range.from, v.range.to)} against {spanLabel(v.before.from, v.before.to)}. Only players who have had the full window count.</div>
        </div>
        <div className={s.cols}>
          <CohortCol title="Paid first match" c={v.cohorts.paid} />
          <CohortCol title="Free first match" c={v.cohorts.free} free />
          <CohortCol title="First-match codes" c={v.cohorts.code} />
        </div>
        <div className={s.note}>
          Paid first-timers went from {n(v.paidShift.before)} to {n(v.paidShift.after)} over the same number of days
          {v.paidShift.after < v.paidShift.before ? ", so some free claims went to people who would have paid." : "."}
          {v.firm14 ? ` 14-day numbers firm up around ${dayLabel(v.firm14)}.` : ""}
        </div>
      </section>

      <section className={s.section} data-testid="ffm-watch">
        <div className={s.secTitle}>Watch list</div>
        <div className={s.watch}>
          <div className={s.wCard}>
            <div className={s.wLabel}>Late cancels, first-timers</div>
            <div className={s.wValue}>{pct(v.watch.late.before.pct)} → {pct(v.watch.late.after.pct)}</div>
            <div className={s.wText}>
              Would-be first-timers who left within 24 hours of kickoff.
              {v.refill.leaves > 0 ? ` On sold-out matches, the seat was bought again ${n(v.refill.refilled)} of ${n(v.refill.leaves)} times.` : ""}
            </div>
          </div>
          <div className={s.wCard}>
            <div className={s.wLabel}>Regulars&apos; match rating</div>
            <div className={s.wValue}>{v.watch.rating.before?.toFixed(2) ?? "—"} → {v.watch.rating.after?.toFixed(2) ?? "—"}</div>
            <div className={s.wText}>
              Players who had played before. Full matches {v.watch.rating.fullBefore?.toFixed(2) ?? "—"} → {v.watch.rating.fullAfter?.toFixed(2) ?? "—"};
              matches with room {v.watch.rating.roomBefore?.toFixed(2) ?? "—"} → {v.watch.rating.roomAfter?.toFixed(2) ?? "—"}.
            </div>
          </div>
          <div className={s.wCard}>
            <div className={s.wLabel}>Regular players coming back</div>
            <div className={s.wValue}>{pct(v.watch.regulars.before.pct)} → {pct(v.watch.regulars.after.pct)}</div>
            <div className={s.wText}>
              Of players who played in the {daysBetweenLabel(v.watch.regulars.afterWindow)} before each window, the share who played again in it:
              {" "}{spanLabel(...v.watch.regulars.beforeWindow)} vs {spanLabel(...v.watch.regulars.afterWindow)}.
            </div>
          </div>
        </div>
      </section>

      <div className={s.fresh}>
        Bookings mirror last synced {v.mirrorSyncedAt ? new Date(v.mirrorSyncedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}{" "}Central. Range ends yesterday: today&apos;s matches have not all been played.
      </div>

      {pending && <SwitchDialog p={pending} cityName={v.cities.find((c) => c.code === pending.row.city)?.name ?? pending.row.city} onRun={run} onClose={close} />}
    </div>
  );
}

const daysBetweenLabel = ([a, b]: [string, string]): string => `${Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1} days`;

function judgedTag(r: Rate) {
  if (r.judged === 0) return <span className={`${s.pill} ${s.pWhite}`}>too early</span>;
  if (r.judged < r.players) return <span className={`${s.pill} ${s.pWhite}`}>{n(r.judged)} judged</span>;
  return null;
}

function CohortCol({ title, c, free }: { title: string; c: View["cohorts"]["paid"]; free?: boolean }) {
  return (
    <div className={`${s.col} ${free ? s.colFree : ""}`} data-testid={`ffm-col-${free ? "free" : title.startsWith("Paid") ? "paid" : "code"}`}>
      <div className={s.colTitle}>{title}</div>
      <div className={s.colSub}>{spanLabel(c.from, c.to)} · {n(c.players)} players</div>
      <div className={s.stat}><span>Came back and paid, 7 days</span><b>{pct(c.paid7.pct)}</b>{judgedTag(c.paid7)}</div>
      <div className={s.stat}><span>Came back and paid, 14 days</span><b>{pct(c.paid14.pct)}</b>{judgedTag(c.paid14)}</div>
      <div className={s.stat}>
        <span>Paid matches per player, 7 days</span><b>{c.perPlayer7.value == null ? "—" : c.perPlayer7.value.toFixed(2)}</b>
        {c.perPlayer7.judged < 100 && <span className={`${s.pill} ${s.pWhite}`}>too early</span>}
      </div>
      <div className={s.stat}>
        <span>Spent in 14 days</span><b>{dollars2(c.spent14.cents)}</b>
        {c.spent14.judged < 100 && <span className={`${s.pill} ${s.pWhite}`}>too early</span>}
      </div>
    </div>
  );
}

function FieldTr({ r, cityName, mayWrite, onSwitch }: { r: FieldRow; cityName: string; mayWrite: boolean; onSwitch: (r: FieldRow, value: boolean) => void }) {
  const total = r.upcoming.length;
  const on = r.upcoming.filter((u) => u.ffe !== false).length;
  const checked = on > 0;
  const state = total === 0 ? "No upcoming" : on === total ? "On" : on === 0 ? "Off" : `On for ${on} of ${total}`;
  const disabled = !mayWrite || total === 0;
  return (
    <tr data-testid="ffm-field-row">
      <td>
        <span className={s.fName}>{r.field}</span>
        {r.noMax && <span className={s.noMax} title="No max player spots set on Field Ops for this field, so a match full at its own size counts as sold out. Set it on Field Ops.">No field max</span>}
      </td>
      <td className={s.fCity}>{cityName}</td>
      <td>
        {r.pct == null ? "—" : r.up
          ? <span className={s.up}>{pct(r.pct)} ↑ from {pct(r.baselinePct)}</span>
          : <span title={`${r.soldOut} of ${r.matches} matches sold out`}>{pct(r.pct)}</span>}
      </td>
      <td>{n(r.freeOnFull)}</td>
      <td className={r.lostCents > 0 ? s.lost : s.zero}>{dollars(r.lostCents)}</td>
      <td className={s.back}>{r.paidBackCents == null ? "—" : dollars(r.paidBackCents)}</td>
      <td>
        <div className={s.sw}>
          <span title={!mayWrite ? "Admins only" : total === 0 ? "No upcoming matches on this field" : undefined}>
            <Toggle on={checked} disabled={disabled} label={`Free first match at ${r.field}`} testId="ffm-switch" onChange={() => onSwitch(r, !checked)} />
          </span>
          {r.turnOff ? <span className={`${s.pill} ${s.pAmber}`}>Turn off?</span> : null}
          <span className={checked ? s.swOn : s.swOff}>{r.turnOff && state === "On" ? "" : state}</span>
        </div>
      </td>
    </tr>
  );
}

const STEP_LABEL: Record<SwitchStep["state"], { text: string; color: string }> = {
  waiting: { text: "Waiting", color: O.muted }, sending: { text: "Sending…", color: O.muted },
  landed: { text: "LANDED", color: O.ok }, notapplied: { text: "NOT APPLIED", color: O.critInk },
  failed: { text: "FAILED", color: O.critInk }, unknown: { text: "UNKNOWN", color: O.warnInk }, not_sent: { text: "Not sent", color: O.muted },
};

function SwitchDialog({ p, cityName, onRun, onClose }: { p: Pending; cityName: string; onRun: () => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const k = p.targets.length;
  const verb = p.value ? "on" : "off";
  const done = !!p.steps && !p.running;
  const landed = p.steps?.filter((x) => x.state === "landed").length ?? 0;
  const list = p.steps ?? p.targets.map((t) => ({ id: t.id, wall: t.wall, state: "waiting" as const }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(7,42,32,.18)" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Turn the free first match ${verb}`} data-testid="ffm-switch-dialog" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-[12px] border px-5 pb-4 pt-5 shadow-[0_12px_40px_rgba(7,42,32,.18)]" style={{ background: O.surface, borderColor: O.line }}>
        <div className="text-[16px] font-bold" style={{ color: O.ink }}>Turn the free first match {verb} at {p.row.field}?</div>
        <div className="mt-1.5 text-[12.5px] leading-[18px]" style={{ color: O.muted }}>
          {cityName}. This changes {k} upcoming {k === 1 ? "match" : "matches"}, one every {GAP_MS / 1000} seconds, each logged like a Match panel save.
          Nothing is retried: the first one that does not land stops the rest.
        </div>
        <div className={s.steps} data-testid="ffm-switch-steps">
          {list.map((x) => (
            <div key={x.id}>
              <div className={s.step}>
                <span style={{ color: O.ink }}>{whenLabel(x.wall)} <span style={{ color: O.muted }}>#{x.id}</span></span>
                <span style={{ color: STEP_LABEL[x.state].color, fontWeight: 600 }}>{STEP_LABEL[x.state].text}</span>
              </div>
              {"note" in x && x.note ? <div className={s.stepNote}>{x.note}</div> : null}
            </div>
          ))}
        </div>
        {done && <div className="mt-3 text-[12.5px] font-semibold" style={{ color: landed === k ? O.ok : O.critInk }} data-testid="ffm-switch-result">{landed} of {k} landed.</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Btn testId="ffm-switch-cancel" disabled={p.running} onClick={onClose}>{done ? "Close" : "Cancel"}</Btn>
          {!done && <Btn kind={p.value ? "primary" : "dangerSolid"} testId="ffm-switch-yes" disabled={p.running} onClick={onRun}>{p.running ? "Working…" : `Turn ${verb} on ${k} ${k === 1 ? "match" : "matches"}`}</Btn>}
        </div>
      </div>
    </div>
  );
}
