"use client";

/* 2026 DAILY MATCHES — the goal sheet, computing itself.
 *
 * Ryan: "it's taking all of september so far to see the daily average games" / "the team for some
 * reason likes to think of it as daily matches for 2026".
 *
 * WHAT IS TYPED AND WHAT IS NOT. Every number on the left is computed from mdapi_matches on every
 * load — the September column, the twelve bars, the weekly equivalents, the gaps, the bands, the
 * totals, and October/November's ramp. The only things a person types are the monthly targets, the
 * not-yet-existing field names, and the actions. The spreadsheet this replaces stores a total of
 * 16.7 while its own rows sum to 16.6, which is what a typed derived number looks like.
 *
 * NO BANNERS, NO EXPLAINER COPY. Ryan: "i dont want any of the extra bullshit banners and warnings
 * and stuff". One line of prose survives — "18 spots = 1 match" beside the unit toggle — because
 * without it "18.5 daily matches" reads as 18.5 matches and it is not. A state that belongs on a
 * row goes on the row: a field with no goal says "no goal" in its own gap cell and is counted
 * nowhere. There is no sentence anywhere telling you how many of those there are.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorText } from "@/lib/errorText";
import {
  MONTH_LABELS, band, fmtUnit, monthKey, ramp, weekly, type Band,
} from "@/lib/fieldGoals";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, cache: "no-store",
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

type MonthCell = { month: string; label: string; spots: number; days: number; daysInMonth: number; partial: boolean; daily: number };
type Action = { id: string; text: string; done: boolean; sortOrder: number };
type Row = {
  key: string; rowId: string | null; kind: "existing" | "slot";
  name: string; city: string | null; venueId: number | null; fieldId: number | null;
  matches: number; monthly: MonthCell[]; targets: Record<string, number>; actions: Action[];
};
type Payload = { year: number; today: string; currentMonth: number; months: MonthCell[]; rows: Row[]; slots: Row[] };

const BAND_HUE: Record<Band, string> = { behind: "#E8553F", warn: "#E8A33F", near: "#8FBF6A", over: "#12694A" };
/* THE CHART'S HUE IS NOT THE BRAND MINT. #2CDB87 fails contrast against this surface at 1.77:1 and
 * sits outside the lightness band; mint is a UI accent, not a chart fill. #0E8A54 passes. */
const CHART_HUE = "#0E8A54";

const RAMP_MONTHS = [9, 10] as const; // October, November — the two the ramp fills
const DEC = 11;

export default function FieldGoals2026() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unit, setUnit] = useState<"day" | "week">("day");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await authFetch("/api/growth/field-goals");
        const j = await res.json();
        if (!live) return;
        if (!res.ok) { setErr(j?.error ?? `Load failed (${res.status})`); return; }
        setData(j as Payload); setErr(null);
      } catch (e) { if (live) setErr(errorText(e, "Failed to load the goals.")); }
    })();
    return () => { live = false; };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /* A ROW HAS TO EXIST BEFORE A TARGET OR AN ACTION CAN HANG OFF IT. A computed row is not stored
   * until somebody gives it something to store — which is why 35 venues render against however few
   * rows the table holds. */
  const ensureRow = useCallback(async (r: Row): Promise<string | null> => {
    if (r.rowId) return r.rowId;
    const ident = r.venueId != null ? { venue_id: r.venueId } : r.fieldId != null ? { field_id: r.fieldId } : null;
    if (!ident) return null;
    const { data: made, error } = await supabase.from("field_goal_rows").insert({ ...ident, city: r.city }).select("id").single();
    if (error) { setErr(errorText(error)); return null; }
    return (made?.id as string) ?? null;
  }, []);

  const setTarget = useCallback(async (r: Row, month: string, value: number | null) => {
    setBusy(true);
    try {
      const rowId = await ensureRow(r);
      if (!rowId) return;
      if (value == null) {
        const { error } = await supabase.from("field_goal_targets").delete().eq("row_id", rowId).eq("month", month);
        if (error) setErr(errorText(error));
      } else {
        const { error } = await supabase.from("field_goal_targets")
          .upsert({ row_id: rowId, month, goal_daily: value }, { onConflict: "row_id,month" });
        if (error) setErr(errorText(error));
      }
      reload();
    } finally { setBusy(false); }
  }, [ensureRow, reload]);

  const addAction = useCallback(async (r: Row, text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const rowId = await ensureRow(r);
      if (!rowId) return;
      const { error } = await supabase.from("field_goal_actions")
        .insert({ row_id: rowId, text: text.trim(), sort_order: (r.actions.at(-1)?.sortOrder ?? 0) + 1 });
      if (error) setErr(errorText(error));
      reload();
    } finally { setBusy(false); }
  }, [ensureRow, reload]);

  const toggleAction = useCallback(async (a: Action) => {
    const { error } = await supabase.from("field_goal_actions").update({ done: !a.done }).eq("id", a.id);
    if (error) setErr(errorText(error));
    reload();
  }, [reload]);

  const removeAction = useCallback(async (a: Action) => {
    const { error } = await supabase.from("field_goal_actions").delete().eq("id", a.id);
    if (error) setErr(errorText(error));
    reload();
  }, [reload]);

  const addSlot = useCallback(async () => {
    const { error } = await supabase.from("field_goal_rows").insert({ slot_name: "New Field - ", sort_order: Date.now() % 1e6 });
    if (error) setErr(errorText(error));
    reload();
  }, [reload]);

  const renameSlot = useCallback(async (r: Row, name: string) => {
    if (!name.trim() || !r.rowId) return;
    const { error } = await supabase.from("field_goal_rows").update({ slot_name: name.trim() }).eq("id", r.rowId);
    if (error) setErr(errorText(error));
    reload();
  }, [reload]);

  const removeSlot = useCallback(async (r: Row) => {
    if (!r.rowId) return;
    const { error } = await supabase.from("field_goal_rows").delete().eq("id", r.rowId);
    if (error) setErr(errorText(error));
    reload();
  }, [reload]);

  const cur = data?.currentMonth ?? 8;
  const rows = useMemo(() => [...(data?.rows ?? [])], [data]);
  const slots = useMemo(() => [...(data?.slots ?? [])], [data]);
  const all = useMemo(() => [...rows, ...slots], [rows, slots]);

  /* THE CURRENT MONTH'S ACTUAL, THE DECEMBER TARGET AND THE GAP — summed at FULL PRECISION over the
   * rows, and rounded once at render. A one-decimal sum of one-decimal rows is how the sheet ends
   * up claiming 16.7 for rows that add to 16.6. */
  const totals = useMemo(() => {
    const now = all.reduce((s, r) => s + (r.monthly[cur]?.daily ?? 0), 0);
    const goal = all.reduce((s, r) => s + (r.targets[monthKey(data?.year ?? 2026, DEC)] ?? 0), 0);
    return { now, goal, gap: goal - now };
  }, [all, cur, data?.year]);

  const decOf = (r: Row) => r.targets[monthKey(data?.year ?? 2026, DEC)] ?? null;
  const sepOf = (r: Row) => r.monthly[cur]?.daily ?? 0;
  const rampOf = (r: Row) => ramp(sepOf(r), decOf(r));

  /* THE TWELVE BARS AND THE TABLE ARE ONE NUMBER. Recorded months come from the months array the
   * route computed off the same filtered matches; October to December are the SUM OF THE ROWS'
   * targets, ramp included, so editing a December goal moves the bar and the headline together. */
  const chart = useMemo(() => {
    if (!data) return [];
    return MONTH_LABELS.map((label, i) => {
      if (i < cur) return { label, value: data.months[i].daily, state: "done" as const, days: data.months[i].days, of: data.months[i].daysInMonth };
      if (i === cur) return { label, value: data.months[i].daily, state: "partial" as const, days: data.months[i].days, of: data.months[i].daysInMonth };
      const k = monthKey(data.year, i);
      const value = all.reduce((s, r) => {
        const typed = r.targets[k];
        if (typed != null) return s + typed;
        if (i === DEC) return s;
        const idx = RAMP_MONTHS.indexOf(i as 9 | 10);
        const v = idx >= 0 ? rampOf(r)[idx] : null;
        return s + (v ?? 0);
      }, 0);
      return { label, value, state: "goal" as const, days: 0, of: data.months[i].daysInMonth };
    });
    // rampOf/decOf are derived from `all` and `data`, which are the dependencies that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, all, cur]);

  if (err) return <p className="p-6 text-[13px] text-red-700" data-testid="fg-error">{err}</p>;
  if (!data) return <p className="p-8 text-center text-[13px]" style={{ color: "#8C9E93" }}>Loading…</p>;

  const u = unit === "day" ? "matches a day" : "matches a week";
  const pct = totals.goal > 0 ? Math.min(100, (totals.now / totals.goal) * 100) : 0;

  return (
    <div className="px-4 pb-16 pt-3" data-testid="fg-page">
      <h1 className="mb-3 text-[27px] font-black uppercase tracking-tight" style={{ color: "#003326" }}>{data.year} Daily Matches</h1>

      {/* ── THE ONE NUMBER, AND IT IS A MONTH RATHER THAN A DAY. Labelled "Today" it read as today's
             count, which is not what a month-to-date average is. ────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-stretch gap-3">
        <Big k={`${MONTH_LABELS[cur]} so far`} v={fmtUnit(totals.now, unit)} u={u} testId="fg-now" />
        <Big k={`Dec ${data.year} goal`} v={fmtUnit(totals.goal, unit)} u={u} tone="#12694A" testId="fg-goal" />
        <Big k="To find" v={fmtUnit(totals.gap, unit)} u={u} tone="#A8341F" testId="fg-gap" />
        <div className="flex min-w-[240px] flex-1 flex-col justify-center rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: "#D3DCD8" }}>
          <div className="relative h-3 overflow-hidden rounded-full border" style={{ background: "#F2F4F3", borderColor: "#D3DCD8" }}>
            <i data-testid="fg-bar" className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#2CDB87,#12694A)" }} />
          </div>
          <div className="mt-2 flex justify-between text-[11.5px]" style={{ color: "#5C6F66" }}>
            <b data-testid="fg-pct" style={{ color: "#003326" }}>{Math.round(pct)}%</b>
            <span data-testid="fg-alt">
              {unit === "day"
                ? `${weekly(totals.now).toFixed(0)} → ${weekly(totals.goal).toFixed(0)} a week`
                : `${totals.now.toFixed(1)} → ${totals.goal.toFixed(1)} a day`}
            </span>
          </div>
        </div>
      </div>

      <YearChart months={chart} unit={unit} />

      <div className="mb-3 mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex overflow-hidden rounded-[9px] border bg-white" style={{ borderColor: "#D3DCD8" }}>
          {(["day", "week"] as const).map((x) => (
            <button key={x} type="button" data-testid={`fg-unit-${x}`} aria-pressed={unit === x}
              onClick={() => setUnit(x)}
              className="px-3.5 py-1.5 text-[12.5px] font-bold"
              style={unit === x ? { background: "#003326", color: "#fff" } : { background: "#fff", color: "#3C4F44" }}>
              {x === "day" ? "Daily" : "Weekly"}
            </button>
          ))}
        </span>
        {/* THE DEFINITION, NOT AN EXPLANATION. Eight characters, and the page needs them. */}
        <span className="text-[11.5px]" data-testid="fg-formula" style={{ color: "#5C6F66" }}>
          {unit === "day" ? "18 spots = 1 match" : "daily × 7"}
        </span>
      </div>

      <GoalTable
        title="Existing fields" rows={rows} unit={unit} year={data.year} cur={cur} busy={busy}
        open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
        onTarget={setTarget} onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
        testId="fg-existing"
      />
      <GoalTable
        title="New fields" rows={slots} unit={unit} year={data.year} cur={cur} busy={busy}
        open={open} setOpen={setOpen} draft={draft} setDraft={setDraft}
        onTarget={setTarget} onAddAction={addAction} onToggleAction={toggleAction} onRemoveAction={removeAction}
        onAddRow={addSlot} onRename={renameSlot} onRemoveRow={removeSlot}
        testId="fg-new"
      />
    </div>
  );
}

function Big({ k, v, u, tone, testId }: { k: string; v: string; u: string; tone?: string; testId: string }) {
  return (
    <div className="min-w-[170px] rounded-2xl border-[1.5px] bg-white px-4 py-3" style={{ borderColor: "#D3DCD8" }} data-testid={testId}>
      <div className="text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: "#5C6F66" }}>{k}</div>
      <div className="mt-0.5 text-[34px] font-black leading-none tracking-tight tabular-nums" style={{ color: tone ?? "#003326" }} data-testid={`${testId}-v`}>{v}</div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: "#5C6F66" }}>{u}</div>
    </div>
  );
}

/* ── THE YEAR, ONE MEASURE, ONE AXIS ───────────────────────────────────────────────────────────
 * Recorded months are solid. The CURRENT month is hatched, because eleven days beside eleven whole
 * months is a lie by omission, and it is direct-labelled with its own value. The remaining months
 * are the same hue OUTLINED — the same measure in a different state, not a second series in a
 * second colour. Three marks, three legend entries, and a tooltip on every bar. */
function YearChart({ months, unit }: { months: { label: string; value: number; state: "done" | "partial" | "goal"; days: number; of: number }[]; unit: "day" | "week" }) {
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const W = 920, H = 250, L = 38, R = 8, T = 16, B = 26;
  const shown = months.map((m) => (unit === "day" ? m.value : weekly(m.value)));
  const max = Math.max(5, Math.ceil(Math.max(...shown, 1) / 5) * 5);
  const iw = W - L - R, ih = H - T - B;
  const step = iw / months.length, bw = Math.min(44, step - 10);
  const y = (v: number) => T + ih - (v / max) * ih;

  return (
    <div className="relative rounded-2xl border-[1.5px] bg-white px-4 pb-2 pt-3" style={{ borderColor: "#D3DCD8" }} data-testid="fg-chart">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div className="text-[13px] font-extrabold">Daily matches by month</div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px]" style={{ color: "#5C6F66" }} data-testid="fg-legend">
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE }} />recorded</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CHART_HUE, opacity: 0.45 }} />month to date</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] border-2" style={{ borderColor: CHART_HUE, background: "#fff" }} />goal</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-visible" role="img" aria-label={`Daily matches by month, ${new Date().getFullYear()}`}>
        <defs>
          <pattern id="fg-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#fff" /><rect width="3" height="6" fill={CHART_HUE} />
          </pattern>
        </defs>
        {Array.from({ length: 5 }, (_, g) => (max / 4) * g).map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="#E8EEEA" strokeWidth={1} />
            <text x={L - 8} y={y(g) + 3.5} textAnchor="end" fontSize={10} fill="#8FA096">{Math.round(g)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const v = shown[i];
          const x = L + i * step + (step - bw) / 2;
          const yy = y(v), h = Math.max(2, T + ih - yy), r = Math.min(4, h / 2);
          const path = `M${x},${T + ih} L${x},${yy + r} Q${x},${yy} ${x + r},${yy} L${x + bw - r},${yy} Q${x + bw},${yy} ${x + bw},${yy + r} L${x + bw},${T + ih} Z`;
          const fill = m.state === "goal" ? "#fff" : m.state === "partial" ? "url(#fg-hatch)" : CHART_HUE;
          return (
            <g key={m.label}>
              <path d={path} fill={fill} stroke={m.state === "done" ? "none" : CHART_HUE} strokeWidth={m.state === "goal" ? 2 : 1.5}
                data-testid={`fg-bar-${m.label}`} data-state={m.state} data-value={v.toFixed(1)} data-fill={fill} />
              <rect x={x - 4} y={T} width={bw + 8} height={ih} fill="transparent"
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                  setTip({ x: e.clientX - (box?.left ?? 0) + 12, y: e.clientY - (box?.top ?? 0) - 10,
                    html: `${m.label} · ${v.toFixed(1)} a ${unit === "day" ? "day" : "week"}` +
                      (m.state === "partial" ? ` · ${m.days} of ${m.of} days so far` : m.state === "goal" ? " · goal" : "") +
                      (unit === "day" ? ` · ${weekly(m.value).toFixed(0)} a week` : "") });
                }}
                onMouseLeave={() => setTip(null)} />
              {m.state !== "done" && (
                <text x={x + bw / 2} y={yy - 6} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#12694A">{v.toFixed(1)}</text>
              )}
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize={10.5}
                fill={m.state === "goal" ? "#8FA096" : "#54655C"} fontWeight={m.state === "partial" ? 800 : 400}>{m.label}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11.5px] text-white"
          data-testid="fg-tip" style={{ left: tip.x, top: tip.y, background: "#0b2018" }}>{tip.html}</div>
      )}
    </div>
  );
}

function GoalTable({
  title, rows, unit, year, cur, busy, open, setOpen, draft, setDraft,
  onTarget, onAddAction, onToggleAction, onRemoveAction, onAddRow, onRename, onRemoveRow, testId,
}: {
  title: string; rows: Row[]; unit: "day" | "week"; year: number; cur: number; busy: boolean;
  open: string | null; setOpen: (k: string | null) => void;
  draft: Record<string, string>; setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onTarget: (r: Row, month: string, v: number | null) => void;
  onAddAction: (r: Row, text: string) => void;
  onToggleAction: (a: Action) => void;
  onRemoveAction: (a: Action) => void;
  onAddRow?: () => void; onRename?: (r: Row, name: string) => void; onRemoveRow?: (r: Row) => void;
  testId: string;
}) {
  const decKey = monthKey(year, DEC);
  return (
    <>
      <h2 className="mb-2 mt-6 flex items-baseline gap-2 text-[15px] font-extrabold">
        {title} <span className="text-[11.5px] font-semibold" style={{ color: "#5C6F66" }} data-testid={`${testId}-count`}>{rows.length}</span>
        {onAddRow && (
          <button type="button" data-testid="fg-add-row" onClick={onAddRow} disabled={busy}
            className="ml-auto rounded-lg border px-3 py-1.5 text-[12px] font-bold"
            style={{ background: "#003326", borderColor: "#003326", color: "#fff" }}>+ Add a new field</button>
        )}
      </h2>
      {/* THE TABLE SCROLLS IN ITS OWN CONTAINER, so a narrow screen never scrolls the page. */}
      <div className="overflow-x-auto rounded-xl border-[1.5px]" style={{ borderColor: "#D3DCD8" }}>
        <table className="w-full min-w-[620px] border-collapse bg-white" data-testid={testId}>
          <thead>
            <tr>
              {["Field", "Progress", MONTH_LABELS[cur], "Oct", "Nov", "Dec", "Gap", "Actions"].map((h, i) => (
                <th key={h} className={`whitespace-nowrap border-b px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider ${i >= 2 && i <= 6 ? "text-right" : "text-left"}`}
                  style={{ color: "#5C6F66", background: "#F2F4F3", borderColor: "#D3DCD8" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sep = r.monthly[cur]?.daily ?? 0;
              const dec = r.targets[decKey] ?? null;
              const noGoal = dec == null;
              const gap = noGoal ? 0 : dec - sep;
              const over = !noGoal && gap < 0;
              const suggestions = ramp(sep, dec);
              const openN = r.actions.filter((a) => !a.done).length;
              return (
                <Fragmentish key={r.key}>
                  <tr data-testid="fg-row" data-key={r.key} data-band={noGoal ? "none" : band(gap)} className="cursor-pointer hover:bg-[#FAFCFB]"
                    onClick={(e) => { if ((e.target as HTMLElement).closest("input,button")) return; setOpen(open === r.key ? null : r.key); }}>
                    <td className="border-t px-3 py-2 text-[13px]" style={{ borderColor: "#EDF2EF" }}>
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" data-testid="fg-dot"
                        style={{ background: noGoal ? "#C3CEC8" : BAND_HUE[band(gap)] }} />
                      {r.kind === "slot" && onRename ? (
                        <input data-testid="fg-slot-name" defaultValue={r.name} disabled={busy}
                          onBlur={(e) => { if (e.target.value.trim() !== r.name) onRename(r, e.target.value); }}
                          className="w-[210px] rounded-md border border-transparent px-1.5 py-0.5 text-[13px] font-bold hover:border-[#D3DCD8] focus:border-[#2CDB87] focus:outline-none" />
                      ) : (
                        <><b className="font-bold">{r.name}</b>{r.city && <span className="ml-1.5 text-[11px]" style={{ color: "#9AA8A1" }}>{r.city}</span>}</>
                      )}
                      {r.kind === "slot" && onRemoveRow && (
                        <button type="button" data-testid="fg-slot-remove" aria-label={`Remove ${r.name}`} disabled={busy}
                          onClick={() => onRemoveRow(r)} className="ml-1 px-1 text-[15px]" style={{ color: "#9AA8A1" }}>×</button>
                      )}
                    </td>
                    <td className="border-t px-3 py-2" style={{ borderColor: "#EDF2EF" }}>
                      {!noGoal && (
                        <span className="relative inline-block h-[7px] w-24 overflow-hidden rounded-full border align-middle" style={{ background: "#F2F4F3", borderColor: "#D3DCD8" }}>
                          <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${dec > 0 ? Math.min(100, (sep / dec) * 100) : 100}%`, background: over ? "#12694A" : "#2CDB87" }} />
                        </span>
                      )}
                    </td>
                    <td className="border-t px-3 py-2 text-right text-[13px] tabular-nums" style={{ borderColor: "#EDF2EF" }} data-testid="fg-actual">{fmtUnit(sep, unit)}</td>
                    {RAMP_MONTHS.map((mi, idx) => {
                      const k = monthKey(year, mi);
                      const typed = r.targets[k];
                      const sugg = suggestions[idx];
                      const shown = typed ?? sugg;
                      return (
                        <td key={k} className="border-t px-3 py-2 text-right" style={{ borderColor: "#EDF2EF" }}>
                          <GoalInput value={shown == null ? "" : fmtUnit(shown, unit)} suggested={typed == null}
                            testId={`fg-goal-${MONTH_LABELS[mi]}`} disabled={busy}
                            title={typed != null ? "set" : noGoal ? "no December goal to ramp to" : "suggested by the ramp from this month to December"}
                            onCommit={(v) => onTarget(r, k, v == null ? null : unit === "day" ? v : v / 7)} />
                        </td>
                      );
                    })}
                    <td className="border-t px-3 py-2 text-right" style={{ borderColor: "#EDF2EF" }}>
                      <GoalInput value={dec == null ? "" : fmtUnit(dec, unit)} suggested={false} placeholder="set"
                        testId="fg-goal-Dec" disabled={busy} title="set"
                        onCommit={(v) => onTarget(r, decKey, v == null ? null : unit === "day" ? v : v / 7)} />
                    </td>
                    <td className="border-t px-3 py-2 text-right text-[13px] font-extrabold tabular-nums" style={{ borderColor: "#EDF2EF" }} data-testid="fg-gap-cell">
                      {noGoal
                        ? <span className="text-[11px] italic font-normal" style={{ color: "#9AA8A1" }}>no goal</span>
                        : <span style={{ color: over ? "#12694A" : "#003326" }}>{over ? "" : "+"}{fmtUnit(gap, unit)}</span>}
                    </td>
                    <td className="border-t px-3 py-2 text-[11px]" style={{ borderColor: "#EDF2EF" }} data-testid="fg-action-count">
                      {r.actions.length
                        ? <span className="rounded-full px-2 py-0.5 font-bold" style={{ background: "#EEF3F0", color: "#5C6F66" }}>{openN} open</span>
                        : <span style={{ color: "#9AA8A1" }}>—</span>}
                    </td>
                  </tr>
                  {open === r.key && (
                    <tr data-testid="fg-actions-row"><td colSpan={8} className="px-3 pb-3" style={{ background: "#FAFCFB" }}>
                      <div className="flex flex-col gap-1.5 pt-1">
                        {r.actions.map((a) => (
                          <div key={a.id} className="flex items-center gap-2 text-[12.5px]" style={{ color: "#3A4D44" }} data-testid="fg-action">
                            <input type="checkbox" checked={a.done} disabled={busy} onChange={() => onToggleAction(a)}
                              className="h-3.5 w-3.5 accent-[#12694A]" aria-label={a.text} />
                            <span className={`min-w-0 flex-1 ${a.done ? "line-through opacity-60" : ""}`}>{a.text}</span>
                            <button type="button" aria-label="Remove action" disabled={busy} onClick={() => onRemoveAction(a)}
                              className="px-1 text-[14px]" style={{ color: "#9AA8A1" }}>×</button>
                          </div>
                        ))}
                        <div className="mt-0.5 flex gap-2">
                          <input data-testid="fg-action-input" placeholder="Add an action" disabled={busy}
                            value={draft[r.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") { onAddAction(r, draft[r.key] ?? ""); setDraft((d) => ({ ...d, [r.key]: "" })); } }}
                            className="max-w-[460px] flex-1 rounded-md border border-dashed bg-white px-2 py-1.5 text-[12.5px]" style={{ borderColor: "#D3DCD8" }} />
                          <button type="button" data-testid="fg-action-add" disabled={busy}
                            onClick={() => { onAddAction(r, draft[r.key] ?? ""); setDraft((d) => ({ ...d, [r.key]: "" })); }}
                            className="rounded-md px-3 text-[12px] font-bold text-white" style={{ background: "#003326" }}>Add</button>
                        </div>
                      </div>
                    </td></tr>
                  )}
                </Fragmentish>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* A SUGGESTED GOAL IS NOT A SET ONE, and it says so by being grey and italic. Typing over it stores
 * a number and it stops being a suggestion; clearing it hands the cell back to the ramp. */
function GoalInput({ value, suggested, onCommit, testId, disabled, title, placeholder }: {
  value: string; suggested: boolean; onCommit: (v: number | null) => void;
  testId: string; disabled: boolean; title: string; placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      data-testid={testId} data-suggested={suggested ? "1" : "0"} title={title} disabled={disabled}
      value={local} placeholder={placeholder ?? "—"} inputMode="decimal"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local.trim() === "") { if (value !== "") onCommit(null); return; }
        const n = Number(local);
        if (!Number.isFinite(n) || n < 0) { setLocal(value); return; }
        if (local !== value) onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={`w-14 rounded-md border border-transparent px-1.5 py-0.5 text-right text-[13px] tabular-nums hover:border-[#D3DCD8] hover:bg-white focus:border-[#2CDB87] focus:bg-white focus:outline-none ${suggested ? "italic" : "font-semibold"}`}
      style={{ color: suggested ? "#9AA8A1" : "#003326" }}
    />
  );
}

// A table row and its action drawer are siblings, so they cannot be wrapped in a div.
function Fragmentish({ children }: { children: React.ReactNode }) { return <>{children}</>; }
