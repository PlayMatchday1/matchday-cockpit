"use client";

/* FREE FIRST MATCH — the page body. Simple v2 (Ryan, 2026-11-22; Figma 9TgSk4sYqq4nNoTH73wRRs frame 21624:72
 * for the layout, 21630:84 for the info boxes, and the comparison section of 21615:72). Three tiles (New players,
 * Come back and pay with a 7 / 14 / 30 day switch, Money so far), one table of fields that sell out with each
 * field's Free Match switch, and the free-vs-paid comparison. Every tile, the comparison and each field row has
 * an "i": its box shows the numbers behind it, "See the players" / "See the matches" opens the list they come
 * from, and "Download CSV" saves it. Every number is the server's (GET /api/lifecycle/free-first-match,
 * freeFirstMatchModel.ts summarize; the lists are listFor on the same selection, so a box adds up to its number).
 *
 * THE FIELD SWITCH writes the match's own firstMatchFreeEnabled on each upcoming match of the field, one at a
 * time, through the Match panel's route (src/lib/ffmFieldSwitch.ts). Admins only (the route refuses anyone else;
 * the greyed switch is courtesy). Nothing retries; the first match that does not land stops it.
 *
 * Removed with simple v2: the subtitle, the verdict banner, the "How we count cost" line, the Free on full and
 * Paid back columns, the "Turn off?" tags and the watch list. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./freeFirstMatch.module.css";
import { Btn, O, Toggle } from "@/components/offers/offersUi";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import { addDays } from "@/lib/weekBuckets";
import {
  GROUP_LABEL, JUDGED_MIN, LAUNCH_DAY, TILE_MIN_JUDGED, WINDOWS,
  type Column, type FieldRow, type Group, type List, type ListKind, type Rate, type View, type Window,
} from "@/lib/freeFirstMatchModel";
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
const dollars2 = (cents: number | null): string => (cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (x: number | null): string => (x == null ? "—" : `${Math.round(x * 100)}%`);
const rangeTxt = (r: Rate): string => (r.range ? `${Math.round(r.range.lo * 100)}–${Math.round(r.range.hi * 100)}%` : "—");
const n = (x: number): string => x.toLocaleString("en-US");

export type Preset = "launch" | "14" | "7";
export const PRESETS: { key: Preset; label: string }[] = [
  { key: "launch", label: "Since Nov 5" }, { key: "14", label: "Last 14 days" }, { key: "7", label: "Last 7 days" },
];
/** The range a preset asks for, from the server's today. "Since Nov 5" sends nothing (the server's default). */
function rangeOf(preset: Preset, today: string | null): { from?: string; to?: string } {
  if (preset === "launch" || !today) return {};
  const to = addDays(today, -1);
  let from = addDays(to, -(Number(preset) - 1));
  if (from < LAUNCH_DAY) from = LAUNCH_DAY;
  return { from, to };
}
const rangeQuery = (preset: Preset, today: string | null, city: string): URLSearchParams => {
  const q = new URLSearchParams();
  const r = rangeOf(preset, today);
  if (r.from) q.set("from", r.from);
  if (r.to) q.set("to", r.to);
  if (city) q.set("city", city);
  return q;
};

const TOP = 5;

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

/* ── INFO BOXES ──────────────────────────────────────────────────────────────────────────────── */

/** What an open box is about. The box is drawn from the view it was opened on, so it always matches the page. */
type Info =
  | { kind: "new" } | { kind: "came" } | { kind: "money" } | { kind: "cohorts" }
  | { kind: "field"; key: string };
type Anchor = { x: number; y: number };
/** A list to fetch: what the "See the …" and "Download CSV" links ask the server for. */
type ListReq = { kind: ListKind; arg?: string; noun: string; count: number };

function InfoButton({ label, onOpen, testId }: { label: string; onOpen: (a: Anchor) => void; testId?: string }) {
  return (
    <button type="button" className={s.iBtn} aria-label={`About ${label}`} data-testid={testId}
      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpen({ x: r.left, y: r.bottom + 8 }); }}>i</button>
  );
}

function csvOf(list: List): string {
  const cell = (v: string | number) => { const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [list.columns, ...list.rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

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
  const [w, setW] = useState<Window>(7);
  const [info, setInfo] = useState<{ what: Info; at: Anchor } | null>(null);
  const [sheet, setSheet] = useState<{ req: ListReq; list: List | null; error: string | null } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reload, setReload] = useState(0);
  const token = authHeaders.Authorization;

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const q = rangeQuery(preset, today.current, city);
        if (fresh.current) { q.set("fresh", "1"); fresh.current = false; }
        const res = await fetch(`/api/lifecycle/free-first-match?${q}`, { headers: { Authorization: token }, cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (View & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (!alive) return;
        setData(body); setError(null); setInfo(null);
        if (!today.current) today.current = body.today;
        onCities(body.cities);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Failed to load"); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, preset, city, reload]);

  // A box closes on Escape, on scroll and on a click anywhere outside it.
  useEffect(() => {
    if (!info) return;
    const close = () => setInfo(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("click", close);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("scroll", close, true); window.removeEventListener("click", close); };
  }, [info]);

  const fetchList = useCallback(async (req: ListReq): Promise<List> => {
    const q = rangeQuery(preset, today.current, city);
    q.set("list", req.kind);
    if (req.arg) q.set("arg", req.arg);
    const res = await fetch(`/api/lifecycle/free-first-match?${q}`, { headers: { Authorization: token }, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (List & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error ?? `Request failed (${res.status})`);
    return body;
  }, [preset, city, token]);

  const openList = useCallback(async (req: ListReq) => {
    setInfo(null);
    setSheet({ req, list: null, error: null });
    try { const list = await fetchList(req); setSheet({ req, list, error: null }); }
    catch (e) { setSheet({ req, list: null, error: e instanceof Error ? e.message : "Failed to load" }); }
  }, [fetchList]);

  const range = data?.range;
  const download = useCallback(async (req: ListReq, have?: List | null) => {
    try {
      const list = have ?? await fetchList(req);
      const url = URL.createObjectURL(new Blob([csvOf(list)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      // Named by the range the page shows (the server's), so two downloads never share a name by accident.
      a.href = url; a.download = `free-first-match-${req.kind}${req.arg ? `-${req.arg.replace(/[^a-z0-9]+/gi, "-")}` : ""}-${range?.from ?? LAUNCH_DAY}-to-${range?.to ?? "latest"}${city ? `-${city}` : ""}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed"); }
  }, [fetchList, range, city]);

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
  const cityName = (c: string) => v.cities.find((x) => x.code === c)?.name ?? c;
  const cw = v.came[w];
  const ch = v.newPlayers.changePct;
  const open = (what: Info) => (at: Anchor) => setInfo({ what, at });
  const openCame = (e: React.MouseEvent<HTMLElement>) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setInfo({ what: { kind: "came" }, at: { x: r.left, y: r.bottom + 8 } }); };
  const callTxt = cw.tooEarly ? "too early" : cw.compare === "same" ? "same as paid" : cw.compare === "better" ? `${Math.abs(cw.diffPts ?? 0)} pts above paid` : cw.compare === "worse" ? `${Math.abs(cw.diffPts ?? 0)} pts below paid` : "—";

  return (
    <div className={s.root} style={{ opacity: loading ? 0.6 : 1, transition: "opacity .15s" }} data-testid="ffm-root">
      {error && <div className={s.note}>{error}</div>}

      <div className={s.tiles3} data-testid="ffm-tiles">
        <div className={s.tile}>
          <div className={s.tHead}><span className={s.tLabel}>New players</span><InfoButton label="New players" onOpen={open({ kind: "new" })} testId="ffm-i-new" /></div>
          <div className={s.tBig}>
            <span className={s.tValue} data-testid="ffm-new">{n(v.newPlayers.after)}</span>
            {ch != null && <span className={ch >= 0 ? s.tGood : s.tBad} data-testid="ffm-new-change">{ch >= 0 ? "+" : ""}{Math.round(ch * 100)}% vs {n(v.newPlayers.before)}</span>}
          </div>
        </div>
        <div className={s.tile}>
          <div className={s.tHead}><span className={s.tLabel}>Come back and pay</span><InfoButton label="Come back and pay" onOpen={open({ kind: "came" })} testId="ffm-i-came" /></div>
          <div className={s.tBig}>
            <span className={s.tValue} data-testid="ffm-came">{cw.tooEarly ? "—" : pct(cw.free.pct)}</span>
            <button type="button" className={`${s.tCall} ${cw.compare === "worse" ? s.tBad : cw.tooEarly ? s.tMuted : s.tGood}`} onClick={openCame} data-testid="ffm-came-call">{callTxt}</button>
          </div>
          <div className={s.seg} role="group" aria-label="Window">
            {WINDOWS.map((d) => <button key={d} type="button" aria-pressed={w === d} onClick={() => setW(d)} data-testid={`ffm-w${d}`}>{d} days</button>)}
          </div>
          <div className={s.tSmall} data-testid="ffm-judged">{n(cw.free.judged)} judged{cw.tooEarly ? ` · needs ${TILE_MIN_JUDGED}` : ""}</div>
        </div>
        <div className={s.tile}>
          <div className={s.tHead}><span className={s.tLabel}>Money so far</span><InfoButton label="Money so far" onOpen={open({ kind: "money" })} testId="ffm-i-money" /></div>
          <div className={s.mLine}><span>Paid back</span><b className={s.tGood} data-testid="ffm-paid-back">+{dollars(v.money.paidBack.cents)}</b></div>
          <div className={s.mLine}><span>Lost on sold-out</span><b className={s.tBad} data-testid="ffm-lost">−{dollars(v.money.lost.cents)}</b></div>
        </div>
      </div>

      <section className={s.section} data-testid="ffm-fields">
        <div className={s.secHead}>
          <span className={s.secTitle}>Fields that sell out</span>
          <InfoButton label="Fields that sell out" onOpen={open({ kind: "field", key: "" })} testId="ffm-i-fields" />
          <div className={s.grow} />
          <span className={s.colHint}>Free match</span>
        </div>
        {v.fields.length === 0 ? <div className={s.note}>No matches in this range.</div> : (
          <div className={s.tableWrap}>
            <table className={s.fields}>
              <thead><tr><th>Field</th><th style={{ width: 140 }}>Sells out</th><th style={{ width: 140 }}>Lost</th><th style={{ width: 170 }} aria-label="Free match" /></tr></thead>
              <tbody>{rows.map((r) => <FieldTr key={r.key} r={r} mayWrite={mayWrite} onSwitch={ask} onInfo={open({ kind: "field", key: r.key })} />)}</tbody>
            </table>
          </div>
        )}
        <div className={s.legend}>
          <span className={s.dot} aria-hidden /> <span>Usually sells out. Consider turning off.</span>
          <div className={s.grow} />
          {v.fields.length > TOP && (
            <button type="button" className={s.more} onClick={() => setShowAll((x) => !x)} data-testid="ffm-show-all">
              {showAll ? "Show top 5" : `Show all ${n(v.fields.length)} fields`}
            </button>
          )}
        </div>
      </section>

      <section className={s.section} data-testid="ffm-cohorts">
        <div className={s.secHead}>
          <div>
            <div className={s.secTitleRow}><span className={s.secTitle}>Free players vs players who paid for their first match</span><InfoButton label="the comparison" onOpen={open({ kind: "cohorts" })} testId="ffm-i-cohorts" /></div>
            <div className={s.secSub}>Same-length windows: {spanLabel(v.range.from, v.range.to)} against {spanLabel(v.before.from, v.before.to)}. Only players who have had the full window count.</div>
          </div>
        </div>
        <div className={s.cols}>
          <CohortCol title="Paid first match" c={v.cohorts.paid} id="paid" />
          <CohortCol title="Free first match" c={v.cohorts.free} id="free" />
          <CohortCol title="First-match codes" c={v.cohorts.code} id="code" />
        </div>
      </section>

      <div className={s.fresh}>
        Bookings mirror last synced {v.mirrorSyncedAt ? new Date(v.mirrorSyncedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}{" "}Central. Ranges end yesterday: today&apos;s matches have not all been played.
      </div>

      {info && <InfoBox v={v} what={info.what} at={info.at} w={w} cityName={cityName} onList={openList} onCsv={(r) => download(r)} />}
      {sheet && <ListSheet sheet={sheet} onClose={() => setSheet(null)} onCsv={() => download(sheet.req, sheet.list)} />}
      {pending && <SwitchDialog p={pending} cityName={cityName(pending.row.city)} onRun={run} onClose={close} />}
    </div>
  );
}

function judgedTag(judged: number) {
  if (judged === 0) return <span className={`${s.pill} ${s.pWhite}`}>too early</span>;
  if (judged < JUDGED_MIN) return <span className={`${s.pill} ${s.pWhite}`}>{n(judged)} judged</span>;
  return null;
}

function CohortCol({ title, c, id }: { title: string; c: Column; id: "paid" | "free" | "code" }) {
  const rate = (r: Rate) => <><b>{pct(r.pct)}</b>{judgedTag(r.judged)}</>;
  return (
    <div className={`${s.col} ${id === "free" ? s.colFree : ""}`} data-testid={`ffm-col-${id}`}>
      <div className={s.colTitle}>{title}</div>
      <div className={s.colSub}>{spanLabel(c.from, c.to)} · {n(c.players)} players</div>
      <div className={s.stat}><span>Came back and paid, 7 days</span>{rate(c.paid7)}</div>
      <div className={s.stat}><span>Came back and paid, 14 days</span>{rate(c.paid14)}</div>
      <div className={s.stat}><span>Came back and paid, 30 days</span>{rate(c.paid30)}</div>
      <div className={s.stat}><span>Paid matches per player, 7 days</span><b>{c.perPlayer7.value == null ? "—" : c.perPlayer7.value.toFixed(2)}</b>{judgedTag(c.perPlayer7.judged)}</div>
      <div className={s.stat}><span>Spent in 14 days</span><b>{dollars2(c.spent14.value)}</b>{judgedTag(c.spent14.judged)}</div>
      <div className={s.stat}><span>Spent in 30 days</span><b>{dollars2(c.spent30.value)}</b>{judgedTag(c.spent30.judged)}</div>
    </div>
  );
}

function FieldTr({ r, mayWrite, onSwitch, onInfo }: { r: FieldRow; mayWrite: boolean; onSwitch: (r: FieldRow, value: boolean) => void; onInfo: (a: Anchor) => void }) {
  const total = r.upcoming.length;
  const on = r.upcoming.filter((u) => u.ffe !== false).length;
  const checked = on > 0;
  const state = total === 0 ? "No upcoming" : on === total ? "On" : on === 0 ? "Off" : `On for ${on} of ${total}`;
  const disabled = !mayWrite || total === 0;
  return (
    <tr data-testid="ffm-field-row">
      <td>
        <span className={s.fCell}>
          <span className={s.fName}>{r.field}</span>
          {r.usually && <span className={s.dot} title="Usually sells out: 40% or more of its matches in the range" data-testid="ffm-dot" />}
          <InfoButton label={r.field} onOpen={onInfo} testId="ffm-i-field" />
          {r.noMax && <span className={s.noMax} title="No max player spots set on Field Ops for this field, so a match full at its own size counts as sold out. Set it on Field Ops.">No field max</span>}
        </span>
      </td>
      <td>{r.pct == null ? "—" : pct(r.pct)}</td>
      <td className={r.lostCents > 0 ? s.lost : s.zero}>{dollars(r.lostCents)}</td>
      <td>
        <div className={s.sw}>
          <span title={!mayWrite ? "Admins only" : total === 0 ? "No upcoming matches on this field" : undefined}>
            <Toggle on={checked} disabled={disabled} label={`Free first match at ${r.field}`} testId="ffm-switch" onChange={() => onSwitch(r, !checked)} />
          </span>
          <span className={checked ? s.swOn : s.swOff}>{state}</span>
        </div>
      </td>
    </tr>
  );
}

/* ── THE BOX ─────────────────────────────────────────────────────────────────────────────────── */

function InfoBox({ v, what, at, w, cityName, onList, onCsv }: {
  v: View; what: Info; at: Anchor; w: Window; cityName: (c: string) => string;
  onList: (r: ListReq) => void; onCsv: (r: ListReq) => void;
}) {
  const W = 440;
  const left = typeof window === "undefined" ? at.x : Math.max(16, Math.min(at.x, window.innerWidth - W - 16));
  const links = (r: ListReq) => (
    <div className={s.boxLinks}>
      <button type="button" onClick={() => onList(r)} data-testid="ffm-see">See the {n(r.count)} {r.noun} →</button>
      <button type="button" onClick={() => onCsv(r)} data-testid="ffm-csv">Download CSV</button>
    </div>
  );
  let body: React.ReactNode = null;
  if (what.kind === "new") {
    const a = v.newPlayers;
    const groups = (g: Record<Group, number>) => (Object.keys(GROUP_LABEL) as Group[]).filter((k) => g[k] > 0).map((k) => `${GROUP_LABEL[k]} ${n(g[k])}`).join(" · ");
    body = (<>
      <div className={s.boxTitle}>New players: first-timers in each period</div>
      <table className={s.boxTable}>
        <thead><tr><th>Period</th><th>Days</th><th>First-timers</th><th>A day</th></tr></thead>
        <tbody>
          <tr><td>Since launch, {spanLabel(v.range.from, v.range.to)}</td><td>{v.range.days}</td><td>{n(a.after)}</td><td><b>{a.afterPerDay.toFixed(1)}</b></td></tr>
          <tr><td>Before, {spanLabel(v.before.from, v.before.to)}</td><td>{v.range.days}</td><td>{n(a.before)}</td><td><b>{a.beforePerDay.toFixed(1)}</b></td></tr>
        </tbody>
      </table>
      <div className={s.boxNote}>
        {a.changePct == null ? "No first-timers before to compare with." : `${a.changePct >= 0 ? "+" : ""}${Math.round(a.changePct * 100)}% = ${n(a.after)} ÷ ${n(a.before)} − 1, over the same number of days.`}
        {" "}Every first-timer counts, however they got the first match. Since launch: {groups(a.afterByGroup) || "none"}. Before: {groups(a.beforeByGroup) || "none"}.
      </div>
      {links({ kind: "new", noun: "players", count: a.after + a.before })}
    </>);
  } else if (what.kind === "came") {
    const c = v.came[w];
    const row = (label: string, r: Rate, bold?: boolean) => <tr><td>{label}</td><td>{n(r.judged)}</td><td>{n(r.hits)}</td><td>{bold ? <b>{pct(r.pct)}</b> : pct(r.pct)}</td><td>{rangeTxt(r)}</td></tr>;
    const call = c.tooEarly
      ? `Too early: only ${n(c.free.judged)} free players have had the full ${w} days (needs ${TILE_MIN_JUDGED}).`
      : c.compare === "same" ? `Same as paid: the 95% ranges overlap (free ${rangeTxt(c.free)}, paid ${rangeTxt(c.paid)}), so the gap is within normal variation.`
      : c.compare === "better" ? `Better than paid: the 95% ranges do not overlap (free ${rangeTxt(c.free)}, paid ${rangeTxt(c.paid)}).`
      : c.compare === "worse" ? `Worse than paid: the 95% ranges do not overlap (free ${rangeTxt(c.free)}, paid ${rangeTxt(c.paid)}).`
      : "No paid first-timers with the window to compare with.";
    body = (<>
      <div className={s.boxTitle}>Came back and paid within {w} days (switch: 7 / 14 / 30)</div>
      <table className={s.boxTable}>
        <thead><tr><th>Group</th><th>Had {w} days</th><th>Paid 2nd</th><th>Rate</th><th>95% range</th></tr></thead>
        <tbody>
          {row(`Free first match, ${spanLabel(v.range.from, v.range.to)}`, c.free, true)}
          {row(`Paid first match, ${spanLabel(v.before.from, v.before.to)}`, c.paid, true)}
          {row(`First-match codes, ${spanLabel(v.before.from, v.before.to)}`, c.code, true)}
        </tbody>
      </table>
      <div className={s.boxNote}>{call} Only players who have had the full {w} days count; a 2nd match counts when it is paid (card or credit, or a member&apos;s spot on a member-free match).</div>
      {links({ kind: "came", arg: String(w), noun: "players", count: c.free.judged + c.paid.judged + c.code.judged })}
    </>);
  } else if (what.kind === "money") {
    const p = v.money.paidBack, l = v.money.lost;
    body = (<>
      <div className={s.boxTitle}>Paid back: +{dollars2(p.cents)}</div>
      <table className={s.boxTable}><tbody>
        <tr><td>Free players since launch</td><td>{n(p.players)}</td></tr>
        <tr><td>…who spent on another match</td><td>{n(p.spenders)}</td></tr>
        <tr><td>Paid matches after their free one</td><td>{n(p.paidMatches)}</td></tr>
        <tr><td>Card charged (own spots, guests, extra spots)</td><td>{dollars2(p.charged)}</td></tr>
        <tr><td>Refunded</td><td>−{dollars2(p.refunded)}</td></tr>
        <tr className={s.boxTot}><td>Paid back</td><td>{dollars2(p.cents)}</td></tr>
      </tbody></table>
      <div className={s.boxNote}>Actual card dollars on matches other than the free one, through {dayLabel(v.range.to)}. Wallet credit is not added; a refunded booking counts as fully refunded.</div>
      {links({ kind: "paidback", noun: "players", count: p.players })}
      <div className={s.boxTitle} style={{ marginTop: 6 }}>Lost on sold-out: −{dollars2(l.cents)}</div>
      <table className={s.boxTable}>
        <thead><tr><th>Price a spot</th><th>Free spots</th><th>Matches</th><th>Lost</th></tr></thead>
        <tbody>
          {l.byPrice.map((b) => <tr key={b.priceCents}><td>{dollars2(b.priceCents)}</td><td>{n(b.spots)}</td><td>{n(b.matches)}</td><td>{dollars2(b.cents)}</td></tr>)}
          <tr className={s.boxTot}><td>Total</td><td>{n(l.spots)}</td><td>{n(l.matches)}</td><td>{dollars2(l.cents)}</td></tr>
        </tbody>
      </table>
      <div className={s.boxNote}>
        Free first-match spots (incl. codes) on matches full at the field&apos;s max (Field Ops), each at that match&apos;s price.
        {l.noMaxMatches > 0 ? ` ${n(l.noMaxMatches)} of these matches are on fields with no max set, judged full at their own size.` : ""}
      </div>
      {links({ kind: "lost", noun: "matches", count: l.matches })}
    </>);
  } else if (what.kind === "cohorts") {
    const c = v.cohorts;
    const cols: [string, Column][] = [["Paid", c.paid], ["Free", c.free], ["Codes", c.code]];
    const r = (label: string, f: (x: Column) => string) => <tr><td>{label}</td>{cols.map(([k, x]) => <td key={k}>{f(x)}</td>)}</tr>;
    body = (<>
      <div className={s.boxTitle}>Free vs paid: the counts behind each column</div>
      <table className={s.boxTable}>
        <thead><tr><th /><th>Paid</th><th>Free</th><th>Codes</th></tr></thead>
        <tbody>
          {r("Players", (x) => n(x.players))}
          {r("Paid 2nd · 7 days", (x) => `${n(x.paid7.hits)} / ${n(x.paid7.judged)}`)}
          {r("Paid 2nd · 14 days", (x) => `${n(x.paid14.hits)} / ${n(x.paid14.judged)}`)}
          {r("Paid 2nd · 30 days", (x) => `${n(x.paid30.hits)} / ${n(x.paid30.judged)}`)}
          {r("Paid matches · 7 days", (x) => `${n(x.perPlayer7.total)} / ${n(x.perPlayer7.judged)}`)}
          {r("Spent · 14 days", (x) => `${dollars2(x.spent14.total)} / ${n(x.spent14.judged)}`)}
          {r("Spent · 30 days", (x) => `${dollars2(x.spent30.total)} / ${n(x.spent30.judged)}`)}
        </tbody>
      </table>
      <div className={s.boxNote}>Each figure is the total over the players who have had the window ÷ how many have. Spent is actual card dollars in the window, the first match included, minus refunds.</div>
      {links({ kind: "cohorts", noun: "players", count: c.paid.players + c.free.players + c.code.players })}
    </>);
  } else if (what.kind === "field" && what.key === "") {
    body = (<>
      <div className={s.boxTitle}>Fields that sell out</div>
      <div className={s.boxNote}>
        Every field with a match played in the range, most money lost first. Sells out = matches full at the field&apos;s max player spots (Field Ops) ÷ matches played.
        Lost = free first-match spots (incl. codes) on those matches × each match&apos;s price. The amber dot marks 40% or more. Open a field&apos;s i for its matches.
      </div>
      {links({ kind: "lost", noun: "matches", count: v.money.lost.matches })}
    </>);
  } else if (what.kind === "field") {
    const r = v.fields.find((f) => f.key === what.key);
    if (r) body = (<>
      <div className={s.boxTitle}>{r.field} · {cityName(r.city)}</div>
      <table className={s.boxTable}><tbody>
        <tr><td>Matches played, {spanLabel(v.range.from, v.range.to)}</td><td>{n(r.matches)}</td></tr>
        <tr><td>…sold out</td><td>{n(r.soldOut)} ({pct(r.pct)})</td></tr>
        <tr><td>Free first-match spots on those matches</td><td>{n(r.freeOnFull)}</td></tr>
        <tr className={s.boxTot}><td>Lost</td><td>{dollars2(r.lostCents)}</td></tr>
      </tbody></table>
      <div className={s.boxNote}>
        Sold out = full at the field&apos;s max player spots (Field Ops).{r.noMax ? " This field has no max set, so full at a match's own size counts." : ""}{" "}Lost = each sold-out match&apos;s free spots × its price.
      </div>
      {links({ kind: "field", arg: r.key, noun: "matches", count: r.matches })}
    </>);
  }
  return (
    <div className={s.box} role="dialog" aria-label="Numbers behind this figure" style={{ left, top: at.y, width: W }} onClick={(e) => e.stopPropagation()} data-testid="ffm-box">
      {body}
    </div>
  );
}

function ListSheet({ sheet, onClose, onCsv }: { sheet: { req: ListReq; list: List | null; error: string | null }; onClose: () => void; onCsv: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const l = sheet.list;
  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.sheet} role="dialog" aria-modal="true" aria-label={l?.title ?? "List"} onClick={(e) => e.stopPropagation()} data-testid="ffm-sheet">
        <div className={s.sheetHead}>
          <div>
            <div className={s.boxTitle}>{l?.title ?? "Loading…"}</div>
            {l && <div className={s.boxNote}>{l.total}</div>}
          </div>
          <div className={s.grow} />
          {l && <Btn onClick={onCsv} testId="ffm-sheet-csv">Download CSV</Btn>}
          <Btn onClick={onClose} testId="ffm-sheet-close">Close</Btn>
        </div>
        {sheet.error && <div className={s.note}>Could not load: {sheet.error}</div>}
        {l && (
          <div className={s.sheetBody}>
            <table className={s.boxTable}>
              <thead><tr>{l.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{l.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── THE SWITCH DIALOG (unchanged) ───────────────────────────────────────────────────────────── */

type Pending = { row: FieldRow; value: boolean; targets: { id: number; wall: string }[]; steps: SwitchStep[] | null; running: boolean };

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
