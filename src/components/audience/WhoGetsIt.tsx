"use client";

// "WHO GETS IT", shared by Push Notifications and the Offers editor (Figma 20828:192 the card with filter rows,
// 20835:159 the Add filter menu, 20835:211 Last played, 20835:230 Exact players). A Filters / Exact players switch;
// filter rows (label, condition, values, ×) joined by AND; + Add filter opens a searchable menu grouped Where / When /
// How much / Who; the live count bar with See players. Every rule and string is src/lib/audienceModel.ts.
//
// The host owns the count and the player lookup (each page asks its own backend) and hands them in; this draws them.
// allowed narrows the menu to what the host's backend takes (Offers takes five filters; pushes take them all).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  dayLabel, filterDef, lastPlayedNote, menuGroups, newRow, opDef, opsFor, todayWall, withOp,
  type Allowed, type AudienceSpec, type FilterKey, type FilterRow,
} from "@/lib/audienceModel";
import { Card, O } from "@/components/offers/offersUi";

// "Oct 3": an instant shown as its Chicago day.
const chicagoDay = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(d); };

type Named = { id: number; name: string };
type FieldLike = { id: number; title: string; cityId: number | null };
// capFlag: the amber line under the count (Figma 20842:72), "38 already got 3 pushes this week and won't get this one."
export type CountBar = { state: "counting" | "ready" | "error" | "off"; text?: string; error?: string; onRetry?: () => void; extra?: React.ReactNode; capFlag?: string | null };
// POST /admin/audiences/sample: up to 50, most recent players first; names as first name and last initial.
export type SampleAnswer = { players: { id: number; name: string | null; city: string | null; lastPlayedAt?: string | null }[]; total?: number; fixture?: boolean } | { error: string };
export type PlayersBox = {
  hint: string; placeholder: string;
  tags: { key: string; label: string }[]; notFound: string[]; line: React.ReactNode | null; extra?: React.ReactNode;
  onRemove: (key: string) => void;
};

export default function WhoGetsIt({ spec, onChange, allowed, cities, fields, nowWall, disabled, count, onSample, players, choices, hints, filtersSub, playersSub, testId = "who" }: {
  spec: AudienceSpec; onChange: (s: AudienceSpec) => void; allowed: Allowed; cities: Named[]; fields: FieldLike[]; nowWall: string; disabled?: boolean;
  count: CountBar; onSample?: () => Promise<SampleAnswer>; players: PlayersBox;
  choices?: Partial<Record<FilterKey, { value: string; label: string }[]>>; hints?: Partial<Record<FilterKey, string>>;
  filtersSub?: string; playersSub?: string; testId?: string;
}) {
  const [menu, setMenu] = useState(false);
  const [lpOpen, setLpOpen] = useState<string | null>(null);
  const [sample, setSample] = useState<SampleAnswer | "loading" | null>(null);
  const today = todayWall(nowWall);
  const filters = spec.mode === "FILTERS";
  const setRows = (rows: FilterRow[]) => onChange({ ...spec, filters: rows });
  const setRow = (r: FilterRow) => setRows(spec.filters.map((x) => (x.id === r.id ? r : x)));
  const add = (key: FilterKey) => {
    const r = newRow(key, allowed, today);
    setRows([...spec.filters, r]);
    setMenu(false);
    if (key === "lastPlayed") setLpOpen(r.id);
  };
  const cityIdsPicked = spec.filters.find((r) => r.key === "city" && r.op === "isAnyOf")?.ids ?? [];
  const fieldOpts = fields.filter((x) => cityIdsPicked.length === 0 || (x.cityId !== null && cityIdsPicked.includes(x.cityId)));
  async function openSample() {
    if (!onSample) return;
    setSample("loading");
    setSample(await onSample());
  }
  return (
    <Card title="Who gets it" sub={filters ? filtersSub ?? "Add as many filters as you need. Players must match all of them." : playersSub ?? "Only these players get it. Filters don't apply and nobody is held back."} testId={`${testId}-card`}>
      <div className="flex gap-1 self-start rounded-full border p-1" style={{ background: O.surface, borderColor: O.line }}>
        {(["FILTERS", "PLAYERS"] as const).map((m) => (
          <button key={m} type="button" data-testid={`${testId}-mode-${m}`} data-on={spec.mode === m ? "1" : "0"} disabled={disabled}
            onClick={() => onChange({ ...spec, mode: m })} className={`rounded-full px-3.5 py-1.5 text-[13px] disabled:cursor-not-allowed ${spec.mode === m ? "font-semibold" : "font-medium"}`}
            style={spec.mode === m ? { background: O.chipOn, color: "#fff" } : { color: O.muted }}>{m === "FILTERS" ? "Filters" : "Exact players"}</button>
        ))}
      </div>

      {filters ? (
        <>
          {spec.filters.length === 0 && <div data-testid={`${testId}-everyone`} className="text-[12px]" style={{ color: O.muted }}>No filters: everyone with an account gets it. Add a filter to narrow it.</div>}
          {spec.filters.map((r, i) => (
            <div key={r.id} className="flex flex-col gap-3.5">
              {i > 0 && <div className="text-[10px] font-bold" style={{ color: "#a6ada8" }}>AND</div>}
              <Row r={r} allowed={allowed} cities={cities} fields={fieldOpts} allFields={fields} today={today} disabled={disabled} choices={choices?.[r.key]} testId={testId}
                lpOpen={lpOpen === r.id} setLpOpen={(v) => setLpOpen(v ? r.id : null)}
                onChange={setRow} onRemove={() => { setRows(spec.filters.filter((x) => x.id !== r.id)); if (lpOpen === r.id) setLpOpen(null); }} />
            </div>
          ))}
          {!disabled && (
            <div className="relative self-start">
              <button type="button" data-testid={`${testId}-add`} onClick={() => setMenu((v) => !v)} className="rounded-full border border-dashed px-3.5 py-2 text-[13px] font-semibold" style={{ borderColor: O.line, color: O.ink, background: O.surface }}>+ Add filter</button>
              {menu && <AddMenu allowed={allowed} hints={hints} used={spec.filters.map((r) => r.key)} onPick={add} onClose={() => setMenu(false)} testId={testId} />}
            </div>
          )}
        </>
      ) : (
        <>
          <textarea data-testid={`${testId}-paste`} rows={4} disabled={disabled} value={spec.playersText} placeholder={players.placeholder}
            onChange={(e) => onChange({ ...spec, playersText: e.target.value })}
            className="h-[110px] w-full rounded-[8px] border px-3 py-2.5 text-[13px] leading-[19px] outline-none disabled:cursor-not-allowed disabled:opacity-60" style={{ borderColor: O.line, color: O.ink, background: O.surface }} />
          <div className="text-[12px]" style={{ color: O.muted }}>{players.hint}</div>
          {(players.tags.length > 0 || players.notFound.length > 0) && (
            <div data-testid={`${testId}-tags`} className="flex flex-wrap gap-x-2 gap-y-1.5">
              {players.tags.slice(0, 60).map((t) => (
                <span key={t.key} data-testid={`${testId}-tag`} className="inline-flex items-center gap-1.5 rounded-full py-[5px] pl-2.5 pr-2 text-[12px] font-semibold" style={{ background: O.mint, color: O.chipOn }}>
                  {t.label}
                  {!disabled && <button type="button" aria-label={`Remove ${t.label}`} className="font-medium" onClick={() => players.onRemove(t.key)}>×</button>}
                </span>
              ))}
              {players.tags.length > 60 && <span className="self-center text-[12px] font-semibold" style={{ color: O.chipOn }}>+ {(players.tags.length - 60).toLocaleString("en-US")} more</span>}
              {players.notFound.length > 0 && (
                <span data-testid={`${testId}-not-found`} title={players.notFound.join(", ")} className="inline-flex rounded-full px-2.5 py-[5px] text-[12px] font-semibold" style={{ background: "#fff2d9", color: "#8c590d" }}>
                  {players.notFound.length.toLocaleString("en-US")} not found: {players.notFound.slice(0, 3).join(", ")}{players.notFound.length > 3 ? "…" : ""}
                </span>
              )}
            </div>
          )}
          {players.line && <div data-testid={`${testId}-players-line`} className="text-[13px] font-semibold" style={{ color: O.chipOn }}>{players.line}</div>}
          {players.extra}
        </>
      )}

      {filters && count.state !== "off" && (
        <div data-testid={`${testId}-count`} data-state={count.state} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] px-3.5 py-3 text-[13px] font-semibold"
          style={count.state === "error" ? { background: O.critBg, color: O.critInk } : { background: O.mint, color: O.chipOn }}>
          <span className="min-w-0 flex-1">{count.state === "error" ? `Couldn't count: ${count.error}` : count.state === "counting" ? "Counting…" : count.text}</span>
          {count.state === "error" && count.onRetry && <button type="button" data-testid={`${testId}-count-retry`} className="underline" onClick={count.onRetry}>Retry</button>}
          {count.state === "ready" && onSample && <button type="button" data-testid={`${testId}-see`} className="whitespace-nowrap" onClick={openSample}>See players ›</button>}
        </div>
      )}
      {filters && count.state === "ready" && count.capFlag && <div data-testid={`${testId}-cap-flag`} className="rounded-[10px] px-3.5 py-[9px] text-[13px] font-semibold" style={{ background: "#fff2d9", color: "#8c590d" }}>{count.capFlag}</div>}
      {filters && count.extra}
      {sample && <SampleList answer={sample} onClose={() => setSample(null)} testId={testId} />}
    </Card>
  );
}

const selectCls = "w-full appearance-none rounded-[8px] border bg-white py-[9px] pl-3 pr-7 text-[13px] outline-none disabled:cursor-not-allowed disabled:opacity-60";
const boxStyle = { borderColor: O.line, color: O.ink } as const;
function Caret() { return <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-medium" style={{ color: O.muted }}>▾</span>; }

function Row({ r, allowed, cities, fields, allFields, today, disabled, choices, lpOpen, setLpOpen, onChange, onRemove, testId }: {
  r: FilterRow; allowed: Allowed; cities: Named[]; fields: FieldLike[]; allFields: FieldLike[]; today: string; disabled?: boolean;
  choices?: { value: string; label: string }[]; lpOpen: boolean; setLpOpen: (v: boolean) => void; onChange: (r: FilterRow) => void; onRemove: () => void; testId: string;
}) {
  const def = filterDef(r.key);
  const ops = opsFor(r.key, allowed);
  const lp = r.key === "lastPlayed";
  return (
    <div className="flex flex-col gap-2">
      <div data-testid={`${testId}-row`} data-key={r.key} className="flex flex-wrap items-center gap-2.5 rounded-[10px] px-3 py-2.5 sm:flex-nowrap" style={{ background: O.page }}>
        <div className="w-full shrink-0 text-[13px] font-semibold sm:w-[130px]" style={{ color: O.ink }}>{def.label}</div>
        <div className="relative w-[150px] shrink-0">
          {lp ? (
            <button type="button" data-testid={`${testId}-op`} disabled={disabled} onClick={() => setLpOpen(!lpOpen)} className={`${selectCls} text-left`} style={boxStyle}>{opDef(r.key, r.op).label}</button>
          ) : ops.length < 2 ? (
            <div data-testid={`${testId}-op`} className={selectCls} style={{ ...boxStyle, opacity: disabled ? 0.6 : 1 }}>{opDef(r.key, r.op).label}</div>
          ) : (
            <select data-testid={`${testId}-op`} disabled={disabled} value={r.op} onChange={(e) => onChange(withOp(r, e.target.value as FilterRow["op"], today))} className={selectCls} style={boxStyle}>
              {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </select>
          )}
          {ops.length >= 2 || lp ? <Caret /> : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Values r={r} cities={cities} fields={fields} allFields={allFields} disabled={disabled} choices={choices ?? def.choices} onChange={onChange} testId={testId} onOpenLp={lp ? () => setLpOpen(true) : undefined} />
        </div>
        {!disabled && <button type="button" data-testid={`${testId}-remove`} aria-label={`Remove ${def.label}`} onClick={onRemove} className="shrink-0 text-[16px] font-medium" style={{ color: O.muted }}>×</button>}
      </div>
      {lp && lpOpen && !disabled && <LastPlayedOptions r={r} ops={ops.map((o) => o.op)} today={today} onChange={onChange} onDone={() => setLpOpen(false)} testId={testId} allFields={allFields} cities={cities} />}
    </div>
  );
}

function Values({ r, cities, fields, allFields, disabled, choices, onChange, testId, onOpenLp }: {
  r: FilterRow; cities: Named[]; fields: FieldLike[]; allFields: FieldLike[]; disabled?: boolean; choices?: { value: string; label: string }[];
  onChange: (r: FilterRow) => void; testId: string; onOpenLp?: () => void;
}) {
  const kind = opDef(r.key, r.op).kind;
  const num = (v: string) => (v === "" ? null : Math.max(0, Math.floor(Number(v))));
  switch (kind) {
    case "cities": case "fields": {
      const opts = kind === "cities" ? cities.map((c) => ({ id: c.id, label: c.name })) : fields.map((f) => ({ id: f.id, label: f.title }));
      const nameOf = (id: number) => (kind === "cities" ? cities.find((c) => c.id === id)?.name ?? `City ${id}` : allFields.find((f) => f.id === id)?.title ?? `Field ${id}`);
      const rest = opts.filter((o) => !r.ids.includes(o.id));
      return (
        <>
          {r.ids.map((id) => (
            <span key={id} data-testid={`${testId}-value-tag`} className="inline-flex items-center gap-1.5 rounded-full py-[5px] pl-2.5 pr-2 text-[12px] font-semibold" style={{ background: O.mint, color: O.chipOn }}>
              {nameOf(id)}
              {!disabled && <button type="button" aria-label={`Remove ${nameOf(id)}`} className="font-medium" onClick={() => onChange({ ...r, ids: r.ids.filter((x) => x !== id) })}>×</button>}
            </span>
          ))}
          {!disabled && rest.length > 0 && (
            <span className="relative">
              <select data-testid={`${testId}-value-add`} value="" onChange={(e) => { const id = Number(e.target.value); if (id) onChange({ ...r, ids: [...r.ids, id] }); }}
                className="w-[110px] appearance-none truncate rounded-[8px] border bg-white py-[7px] pl-3 pr-3 text-[13px] outline-none" style={{ borderColor: O.line, color: O.muted }}>
                <option value="">{kind === "cities" ? "+ city" : "+ field"}</option>
                {rest.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </span>
          )}
        </>
      );
    }
    case "date": return <DateBox value={r.date} disabled={disabled} onChange={(d) => onChange({ ...r, date: d })} testId={`${testId}-date`} onOpen={onOpenLp} />;
    case "dateRange": return (
      <>
        <DateBox value={r.date} disabled={disabled} onChange={(d) => onChange({ ...r, date: d })} testId={`${testId}-date`} onOpen={onOpenLp} />
        <span className="text-[12px]" style={{ color: O.muted }}>and</span>
        <DateBox value={r.date2} disabled={disabled} onChange={(d) => onChange({ ...r, date2: d })} testId={`${testId}-date2`} onOpen={onOpenLp} />
      </>
    );
    case "days": return (
      <>
        <input data-testid={`${testId}-n`} type="number" min={1} disabled={disabled} value={r.n ?? ""} onChange={(e) => onChange({ ...r, n: num(e.target.value) })} className="w-[70px] rounded-[8px] border bg-white px-3 py-[9px] text-[13px] outline-none disabled:opacity-60" style={boxStyle} />
        <span className="text-[12px]" style={{ color: O.muted }}>{r.op === "withinDays" ? "days" : "days ago"}</span>
      </>
    );
    case "int": return <input data-testid={`${testId}-n`} type="number" min={0} disabled={disabled} value={r.n ?? ""} onChange={(e) => onChange({ ...r, n: num(e.target.value) })} className="w-[70px] rounded-[8px] border bg-white px-3 py-[9px] text-[13px] outline-none disabled:opacity-60" style={boxStyle} />;
    case "intRange": return (
      <>
        <input data-testid={`${testId}-n`} type="number" min={0} disabled={disabled} value={r.n ?? ""} onChange={(e) => onChange({ ...r, n: num(e.target.value) })} className="w-[70px] rounded-[8px] border bg-white px-3 py-[9px] text-[13px] outline-none disabled:opacity-60" style={boxStyle} />
        <span className="text-[12px]" style={{ color: O.muted }}>and</span>
        <input data-testid={`${testId}-n2`} type="number" min={0} disabled={disabled} value={r.n2 ?? ""} onChange={(e) => onChange({ ...r, n2: num(e.target.value) })} className="w-[70px] rounded-[8px] border bg-white px-3 py-[9px] text-[13px] outline-none disabled:opacity-60" style={boxStyle} />
      </>
    );
    case "choice": return (
      <div className="relative w-[150px]">
        <select data-testid={`${testId}-choice`} disabled={disabled} value={r.choice ?? ""} onChange={(e) => onChange({ ...r, choice: e.target.value })} className={selectCls} style={boxStyle}>
          {(choices ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <Caret />
      </div>
    );
    case "text": return <input data-testid={`${testId}-text`} disabled={disabled} value={r.text ?? ""} onChange={(e) => onChange({ ...r, text: e.target.value })} className="w-[80px] rounded-[8px] border bg-white px-3 py-[9px] text-[13px] outline-none disabled:opacity-60" style={boxStyle} />;
    case "none": return null;
  }
}

// "Oct 1, 2026 📅": the label as staff read it, with the browser's own date picker over it.
function DateBox({ value, disabled, onChange, testId, onOpen }: { value: string | null; disabled?: boolean; onChange: (d: string) => void; testId: string; onOpen?: () => void }) {
  return (
    <label className="relative flex w-[160px] items-center rounded-[8px] border bg-white py-[9px] pl-3 pr-2.5 text-[13px]" style={{ ...boxStyle, opacity: disabled ? 0.6 : 1 }}>
      <span data-testid={`${testId}-label`} className="flex-1 whitespace-pre">{value ? dayLabel(value) : "Pick a date"}</span><span aria-hidden>📅</span>
      <input data-testid={testId} type="date" disabled={disabled} value={value ?? ""} aria-label="Date"
        onClick={(e) => { onOpen?.(); try { e.currentTarget.showPicker?.(); } catch { /* older browsers */ } }}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    </label>
  );
}

// LAST PLAYED (20835:211): the six ways to say it as chips, the value for the chosen one, and what it means.
function LastPlayedOptions({ r, ops, today, onChange, onDone, testId, allFields, cities }: {
  r: FilterRow; ops: FilterRow["op"][]; today: string; onChange: (r: FilterRow) => void; onDone: () => void; testId: string; allFields: FieldLike[]; cities: Named[];
}) {
  const LABEL: Partial<Record<FilterRow["op"], string>> = { before: "Before", since: "Since", between: "Between", moreThanDaysAgo: "More than N days ago", withinDays: "Within N days", never: "Never" };
  return (
    <div data-testid={`${testId}-lp-options`} className="flex flex-col gap-3 rounded-[12px] border px-4 pb-4 pt-3.5 sm:ml-[140px]" style={{ background: O.surface, borderColor: O.line }}>
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-bold" style={{ color: O.ink }}>Last played</div>
        <button type="button" data-testid={`${testId}-lp-done`} onClick={onDone} className="text-[12px] font-semibold" style={{ color: O.ok }}>Done</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ops.map((op) => (
          <button key={op} type="button" data-testid={`${testId}-lp-${op}`} data-on={r.op === op ? "1" : "0"} onClick={() => onChange(withOp(r, op, today))}
            className={`rounded-full border px-3 py-1.5 text-[12px] ${r.op === op ? "font-semibold" : "font-medium"}`}
            style={r.op === op ? { background: O.chipOn, borderColor: O.chipOn, color: "#fff" } : { borderColor: O.line, color: O.ink, background: O.surface }}>{LABEL[op] ?? op}</button>
        ))}
      </div>
      {r.op !== "never" && <div className="flex flex-wrap items-center gap-1.5"><Values r={r} cities={cities} fields={allFields} allFields={allFields} onChange={onChange} testId={`${testId}-lp`} /></div>}
      <div data-testid={`${testId}-lp-note`} className="text-[12px]" style={{ color: O.muted }}>{lastPlayedNote(r)}</div>
    </div>
  );
}

// THE ADD FILTER MENU (20835:159).
function AddMenu({ allowed, hints, used, onPick, onClose, testId }: { allowed: Allowed; hints?: Partial<Record<FilterKey, string>>; used: FilterKey[]; onPick: (k: FilterKey) => void; onClose: () => void; testId: string }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => menuGroups(q, allowed, used, hints), [q, allowed, used, hints]);
  useEffect(() => {
    const out = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", out); window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); window.removeEventListener("keydown", esc); };
  }, [onClose]);
  return (
    <div ref={ref} data-testid={`${testId}-menu`} className="absolute left-0 top-[calc(100%+6px)] z-30 flex max-h-[520px] w-[340px] max-w-[calc(100vw-48px)] flex-col gap-0.5 overflow-y-auto rounded-[12px] border p-2 shadow-[0_8px_24px_rgba(0,0,0,0.14)]" style={{ background: O.surface, borderColor: O.line }}>
      <input data-testid={`${testId}-menu-search`} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filters" aria-label="Search filters"
        className="mb-1 rounded-[8px] border px-2.5 py-2 text-[13px] outline-none placeholder:text-[#5e6b66]" style={{ borderColor: O.line, color: O.ink }} />
      {groups.length === 0 && <div className="px-2.5 py-3 text-[12px]" style={{ color: O.muted }}>{used.length ? "Nothing else matches. Each filter can be used once." : "No filter matches that."}</div>}
      {groups.map((g) => (
        <div key={g.group} className="flex flex-col gap-0.5">
          <div className="px-1 pt-1 text-[10px] font-bold" style={{ color: "#a6ada8" }}>{g.group.toUpperCase()}</div>
          {g.entries.map((e) => (
            <button key={e.key} type="button" data-testid={`${testId}-menu-${e.key}`} onClick={() => onPick(e.key)} className="flex flex-col gap-px rounded-[8px] px-2.5 py-[7px] text-left hover:bg-[#e3f7ed]">
              <span className="text-[13px] font-semibold" style={{ color: O.ink }}>{e.label}</span>
              <span className="text-[12px]" style={{ color: O.muted }}>{e.hint}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// SEE PLAYERS: a sample of who matches, from the backend.
function SampleList({ answer, onClose, testId }: { answer: SampleAnswer | "loading"; onClose: () => void; testId: string }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(7,42,32,.18)" }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Players who match" data-testid={`${testId}-sample`} onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[460px] flex-col gap-3 rounded-[14px] border p-5 shadow-[0_12px_40px_rgba(7,42,32,.18)]" style={{ background: O.surface, borderColor: O.line }}>
        <div className="flex items-start justify-between">
          <div className="text-[16px] font-bold" style={{ color: O.ink }}>Players who match</div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-[14px]" style={{ color: O.muted }}>✕</button>
        </div>
        {answer === "loading" ? <div className="text-[13px]" style={{ color: O.muted }}>Loading…</div>
          : "error" in answer ? <div data-testid={`${testId}-sample-error`} className="text-[13px]" style={{ color: O.critInk }}>{answer.error}</div>
          : (
            <>
              <div className="text-[12px]" style={{ color: O.muted }}>
                {answer.players.length === 0 ? "Nobody matches right now." : `The ${answer.players.length.toLocaleString("en-US")} most recent players who match${typeof answer.total === "number" ? ` (of ${answer.total.toLocaleString("en-US")})` : ""}.`}{answer.fixture ? " Stand-in data from the dev fixture, not real players." : ""}
              </div>
              <div className="flex flex-col overflow-y-auto rounded-[10px] border" style={{ borderColor: O.line }}>
                {answer.players.map((p) => (
                  <div key={p.id} data-testid={`${testId}-sample-row`} className="flex items-center gap-3 border-b px-3 py-2 text-[13px] last:border-b-0" style={{ borderColor: O.line }}>
                    <span className="w-[56px] shrink-0 font-mono text-[12px]" style={{ color: O.muted }}>#{p.id}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold" style={{ color: O.ink }}>{p.name ?? "No name"}</span>
                    <span className="shrink-0 text-[12px]" style={{ color: O.muted }}>{p.city ?? ""}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: O.muted }}>{p.lastPlayedAt ? `Played ${chicagoDay(p.lastPlayedAt)}` : "Never played"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
