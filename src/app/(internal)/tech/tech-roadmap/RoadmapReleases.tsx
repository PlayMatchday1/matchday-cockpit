"use client";

// The Releases tab (Figma 19428:45): a timeline, one collapsible card per release, then the work
// that is in no release and what is already out this year. Plus the release dialog (19429:154759),
// which creates a release and edits one.

import { useEffect, useMemo, useState } from "react";
import type { KanbanCard, RoadmapBoard } from "@/lib/kanban";
import {
  buildTimeline, doneYmd, fmtRange, readOpen, releaseOpenKey, releaseStatus, sortReleases, writeOpen,
  ymdToUtcMs, type Release,
} from "@/lib/roadmapReleases";
import type { ReleaseInput } from "@/lib/useRoadmapReleases";
import { firstLinePlain } from "@/lib/richText";
import { C, Pill, ReleaseStatusChip, StageChip, StageDot, VersionChip, WhoChip, descriptionOf } from "./roadmapUi";

const byCreated = (a: KanbanCard, b: KanbanCard) =>
  (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.sort_order - b.sort_order || a.id.localeCompare(b.id);

export default function RoadmapReleases({ board, cards, releases, today, viewer, isAdmin, passes, onOpenCard, onAddWork, onEditRelease }: {
  board: RoadmapBoard;
  cards: KanbanCard[]; // this board's cards, unfiltered
  releases: Release[];
  today: string;
  viewer: string;
  isAdmin: boolean;
  passes: (c: KanbanCard) => boolean; // search + who
  onOpenCard: (id: string) => void;
  onAddWork: (releaseId: string | null) => void;
  onEditRelease: (r: Release) => void;
}) {
  const sorted = useMemo(() => sortReleases(releases), [releases]);
  const year = today.slice(0, 4);
  const loose = cards.filter((c) => !c.release_id && c.stage !== "shipped").sort(byCreated);
  const looseShown = loose.filter(passes);
  const outYear = cards
    .filter((c) => !c.release_id && c.stage === "shipped" && (doneYmd(c) ?? "").slice(0, 4) === year)
    .sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));
  const outShown = outYear.filter(passes);
  const [outOpen, setOutOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5" data-board={board}>
      <Timeline releases={sorted} cards={cards} today={today} isAdmin={isAdmin} onEdit={onEditRelease} />

      {sorted.map((r) => (
        <ReleaseCard key={r.id} r={r} cards={cards.filter((c) => c.release_id === r.id)} allCards={cards} today={today}
          viewer={viewer} isAdmin={isAdmin} passes={passes} onOpenCard={onOpenCard} onAdd={() => onAddWork(r.id)} onEdit={() => onEditRelease(r)} />
      ))}

      <section data-testid="not-in-release" className="flex flex-col gap-3 rounded-[14px] bg-white px-5 pb-5 pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="m-0 text-[17px] font-bold" style={{ color: C.ink }}>Not in a release yet</h3>
          <Pill bg={C.grey} ink={C.muted}>{loose.length} {loose.length === 1 ? "item" : "items"}</Pill>
          <span className="flex-1" />
          {loose.length > 0 && <span className="text-[12px]" style={{ color: C.muted }}>Open one and pick a release to schedule it</span>}
        </div>
        {looseShown.length === 0
          ? <p className="m-0 text-[13px]" style={{ color: C.muted }}>{loose.length ? "Nothing here matches the search." : "Everything open is in a release."}</p>
          : (
            <div className="flex flex-wrap gap-2">
              {looseShown.map((c) => (
                <button key={c.id} type="button" data-testid="loose-card" onClick={() => onOpenCard(c.id)}
                  className="rounded-[8px] px-3 py-2 text-left text-[13px] font-medium" style={{ background: C.soft, color: C.ink }}>{c.title}</button>
              ))}
            </div>
          )}
        {isAdmin && <button type="button" onClick={() => onAddWork(null)} className="self-start text-[13px] font-semibold" style={{ color: C.link }}>+ Add work</button>}
      </section>

      <section data-testid="out-this-year" className="rounded-[14px] bg-white px-5 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="m-0 text-[17px] font-bold" style={{ color: C.ink }}>Out this year</h3>
          <Pill bg={C.mint} ink={C.forest}>{outYear.length}</Pill>
          {!outOpen && outYear.length > 0 && (
            <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: C.muted }}>
              {outYear.slice(0, 4).map((c) => c.title).join(" · ")}{outYear.length > 4 ? ` · +${outYear.length - 4} more` : ""}
            </span>
          )}
          <span className="flex-1" />
          {outYear.length > 0 && (
            <button type="button" data-testid="out-toggle" onClick={() => setOutOpen((v) => !v)} className="text-[13px] font-semibold" style={{ color: C.link }}>{outOpen ? "Hide" : "Show"}</button>
          )}
        </div>
        {outOpen && (
          <div className="mt-3">
            {outShown.length === 0
              ? <p className="m-0 text-[13px]" style={{ color: C.muted }}>Nothing here matches the search.</p>
              : outShown.map((c) => <WorkRow key={c.id} c={c} onOpen={() => onOpenCard(c.id)} flush />)}
          </div>
        )}
        {outYear.length === 0 && <p className="m-0 mt-2 text-[13px]" style={{ color: C.muted }}>Nothing finished outside a release this year.</p>}
      </section>
    </div>
  );
}

// ── timeline ───────────────────────────────────────────────────────────────
function Timeline({ releases, cards, today, isAdmin, onEdit }: { releases: Release[]; cards: KanbanCard[]; today: string; isAdmin: boolean; onEdit: (r: Release) => void }) {
  if (releases.length === 0) {
    return (
      <section data-testid="timeline" className="rounded-[14px] bg-white px-5 py-[18px]">
        <h3 className="m-0 text-[16px] font-bold" style={{ color: C.ink }}>Timeline</h3>
        <p className="m-0 mt-2 text-[13px]" style={{ color: C.muted }}>No releases yet. {isAdmin ? "Use + New release to plan the first one." : ""}</p>
      </section>
    );
  }
  const t = buildTimeline(releases, today);
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  const statuses = releases.map((r) => releaseStatus(r, cards, today));
  const ROW = 40;
  return (
    <section data-testid="timeline" className="flex flex-col gap-3.5 rounded-[14px] bg-white px-5 pb-5 pt-[18px]">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        <h3 className="m-0 text-[16px] font-bold" style={{ color: C.ink }}>Timeline</h3>
        <span className="text-[12px]" style={{ color: C.muted }}>{t.title}</span>
        <span className="flex-1" />
        <Legend swatch={<span className="h-2 w-3.5 rounded-[3px]" style={{ background: C.accent }} />} label="Building" />
        <Legend swatch={<span className="h-2 w-3.5 rounded-[3px] border" style={{ background: C.planBg, borderColor: C.planLine }} />} label="Planned" />
        {statuses.includes("out") && <Legend swatch={<span className="h-2 w-3.5 rounded-[3px] border" style={{ background: C.mint, borderColor: C.accent }} />} label="Out" />}
        <Legend swatch={<span className="h-3 w-[2px]" style={{ background: C.today }} />} label="Today" />
      </div>
      <div className="overflow-x-auto">
        <div className="relative min-w-[640px]" style={{ height: 34 + releases.length * ROW }}>
          {/* labels */}
          {releases.map((r, i) => (
            <div key={r.id} className="absolute left-0 flex w-[200px] items-center gap-2 overflow-hidden" style={{ top: 34 + i * ROW, height: 24 }}>
              <VersionChip v={r.version} />
              <span className="truncate text-[13px] font-semibold" style={{ color: C.ink }}>{r.name}</span>
            </div>
          ))}
          {/* chart */}
          <div className="absolute inset-y-0 left-[210px] right-0" data-testid="timeline-chart">
            {t.months.map((m) => {
              const x = (m.ms - t.startMs) / (t.endMs - t.startMs);
              return (
                <div key={m.ms} className="absolute inset-y-0" style={{ left: pct(x) }}>
                  <div className="absolute inset-y-0 w-px" style={{ background: "#eceeea" }} />
                  <span className="absolute left-1.5 top-1 text-[11px] font-semibold tracking-[0.4px]" style={{ color: C.faint }}>{m.label}</span>
                </div>
              );
            })}
            {releases.map((r, i) => {
              const st = statuses[i];
              const left = t.at(r.starts_on);
              const width = t.endOf(r.out_by) - left;
              const style = st === "building" ? { background: C.accent, color: C.forest }
                : st === "out" ? { background: C.mint, border: `1px solid ${C.accent}`, color: C.forest }
                : { background: C.planBg, border: `1px solid ${C.planLine}`, color: C.ink };
              return (
                <button key={r.id} type="button" data-testid="timeline-bar" data-release={r.version} data-left={left.toFixed(5)} data-width={width.toFixed(5)}
                  disabled={!isAdmin} onClick={() => onEdit(r)} title={isAdmin ? "Edit release" : undefined}
                  className="absolute flex h-6 items-center overflow-hidden whitespace-nowrap rounded-[6px] px-2.5 text-[11px] font-semibold disabled:cursor-default"
                  style={{ ...style, top: 34 + i * ROW, left: pct(left), width: pct(width) }}>
                  {fmtRange(r.starts_on, r.out_by)}
                </button>
              );
            })}
            <div data-testid="today-line" data-today={today} data-left={t.at(today).toFixed(5)} className="absolute bottom-0 w-[2px]"
              style={{ top: 20, left: `calc(${pct((t.at(today) + t.endOf(today)) / 2)} - 1px)`, background: C.today }} />
          </div>
        </div>
      </div>
    </section>
  );
}
function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: C.muted }}>{swatch}{label}</span>;
}

// ── one release ────────────────────────────────────────────────────────────
function ReleaseCard({ r, cards, allCards, today, viewer, isAdmin, passes, onOpenCard, onAdd, onEdit }: {
  r: Release; cards: KanbanCard[]; allCards: KanbanCard[]; today: string; viewer: string; isAdmin: boolean;
  passes: (c: KanbanCard) => boolean; onOpenCard: (id: string) => void; onAdd: () => void; onEdit: () => void;
}) {
  const key = releaseOpenKey(viewer, r.id);
  const [open, setOpen] = useState(true);
  useEffect(() => { setOpen(readOpen(key, true)); }, [key]);
  const toggle = () => setOpen((v) => { writeOpen(key, !v); return !v; });
  const [showDone, setShowDone] = useState(false);

  const status = releaseStatus(r, allCards, today);
  const done = cards.filter((c) => c.stage === "shipped").sort(byCreated);
  const openWork = cards.filter((c) => c.stage !== "shipped").sort(byCreated);
  const ryan = cards.filter((c) => c.assignee === "ryan").length;
  const scrum = cards.filter((c) => c.assignee === "scrumlaunch").length;
  const frac = cards.length ? done.length / cards.length : 0;

  return (
    <section data-testid="release-card" data-release={r.version} data-open={open ? "1" : "0"} className="overflow-hidden rounded-[14px] bg-white">
      <div className="flex items-center">
        <button type="button" data-testid="release-header" aria-expanded={open} onClick={toggle}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-2 py-4 pl-5 pr-2 text-left">
          <VersionChip v={r.version} size="md" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[17px] font-bold" style={{ color: C.ink }}>{r.name}</span>
            <span className="text-[12px]" style={{ color: C.muted }}>{fmtRange(r.starts_on, r.out_by)}</span>
          </span>
          <span className="hidden flex-1 sm:block" />
          <span className="flex items-center gap-1.5">
            {ryan > 0 && <Pill bg={C.mint} ink={C.forest}>Ryan {ryan}</Pill>}
            {scrum > 0 && <Pill bg={C.blueBg} ink={C.blueInk}>ScrumLaunch {scrum}</Pill>}
          </span>
          <span className="flex w-[130px] flex-col gap-[5px]">
            <span data-testid="release-progress" className="text-[12px] font-medium" style={{ color: C.muted }}>{done.length} of {cards.length} done</span>
            <span className="relative h-1.5 w-[130px] overflow-hidden rounded-[3px]" style={{ background: "#e9ece8" }}>
              <span className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${frac * 100}%`, background: C.accent }} />
            </span>
          </span>
          <ReleaseStatusChip status={status} />
          <img src="/roadmap/release-chevron.svg" alt="" width={16} height={16} className="block flex-none transition-transform" style={{ transform: open ? "none" : "rotate(-90deg)" }} />
        </button>
        {isAdmin && (
          <button type="button" data-testid="release-edit" onClick={onEdit} aria-label={`Edit ${r.version}`} title="Edit release" className="flex-none py-4 pl-1 pr-4">
            <img src="/roadmap/pencil.svg" alt="" width={16} height={16} className="block" />
          </button>
        )}
      </div>
      {open && (
        <div>
          {openWork.filter(passes).map((c) => <WorkRow key={c.id} c={c} onOpen={() => onOpenCard(c.id)} />)}
          {cards.length > 0 && openWork.filter(passes).length === 0 && done.length === 0 && (
            <p className="m-0 border-t px-5 py-3 text-[13px]" style={{ borderColor: C.line, color: C.muted }}>Nothing here matches the search.</p>
          )}
          {cards.length === 0 && <p className="m-0 border-t px-5 py-3 text-[13px]" style={{ borderColor: C.line, color: C.muted }}>No work in this release yet.</p>}
          {done.length > 0 && (
            <>
              <button type="button" data-testid="done-fold" data-count={done.length} onClick={() => setShowDone((v) => !v)}
                className="flex w-full items-center gap-2 border-t py-2.5 pl-[46px] pr-5 text-left text-[13px] font-semibold" style={{ borderColor: C.line }}>
                <img src="/roadmap/done-check.svg" alt="" width={14} height={14} className="block" />
                <span style={{ color: C.muted }}>{done.length} done</span>
                <span style={{ color: C.muted }}>·</span>
                <span style={{ color: C.link }}>{showDone ? "Hide" : "Show"}</span>
              </button>
              {showDone && done.filter(passes).map((c) => <WorkRow key={c.id} c={c} onOpen={() => onOpenCard(c.id)} />)}
            </>
          )}
          {isAdmin && (
            <button type="button" data-testid="release-add" onClick={onAdd} className="block w-full border-t pb-[13px] pl-[46px] pr-5 pt-[11px] text-left text-[13px] font-semibold" style={{ borderColor: C.line, color: C.link }}>
              + Add work to {r.version}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function WorkRow({ c, onOpen, flush }: { c: KanbanCard; onOpen: () => void; flush?: boolean }) {
  const line = firstLinePlain(descriptionOf(c));
  return (
    <button type="button" data-testid="work-row" data-card-id={c.id} data-stage={c.stage} onClick={onOpen}
      className={`flex w-full items-center gap-3 border-t py-[11px] text-left ${flush ? "px-0" : "px-5"}`} style={{ borderColor: C.line }}>
      <StageDot stage={c.stage} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold" style={{ color: C.ink }}>{c.title}</span>
        {line && <span data-testid="work-row-line" className="truncate text-[12px]" style={{ color: C.muted }}>{line}</span>}
      </span>
      <WhoChip who={c.assignee} />
      <span className="hidden w-[108px] flex-none justify-end sm:flex"><StageChip stage={c.stage} /></span>
    </button>
  );
}

// ── the release dialog ─────────────────────────────────────────────────────
const addDays = (ymd: string, n: number) => new Date(ymdToUtcMs(ymd) + n * 86_400_000).toISOString().slice(0, 10);

/** The next version after the highest one on the board: 1.88 → 1.89, 2.0 → 2.1. */
export function suggestVersion(releases: Release[]): string {
  const nums = releases.map((r) => r.version).filter((v) => /^\d+\.\d+$/.test(v));
  if (!nums.length) return "";
  const top = nums.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const [maj, min] = top.split(".");
  return `${maj}.${(Number(min) + 1).toString().padStart(min.length, "0")}`;
}

export function ReleaseDialog({ existing, releases, today, onClose, onSave }: {
  existing: Release | null;
  releases: Release[];
  today: string;
  onClose: () => void;
  onSave: (input: Partial<ReleaseInput>) => Promise<string | null>;
}) {
  const [version, setVersion] = useState(existing?.version ?? suggestVersion(releases));
  const [name, setName] = useState(existing?.name ?? "");
  const [start, setStart] = useState(existing?.starts_on ?? today);
  const [outBy, setOutBy] = useState(existing?.out_by ?? addDays(today, 28));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!version.trim()) return setErr("Give it a version.");
    if (!start || !outBy) return setErr("Pick both dates.");
    if (outBy < start) return setErr("The out by date has to be on or after the start.");
    const full: ReleaseInput = { version: version.trim(), name: name.trim(), starts_on: start, out_by: outBy };
    // Editing sends only what changed.
    const patch: Partial<ReleaseInput> = existing
      ? Object.fromEntries(Object.entries(full).filter(([k, v]) => existing[k as keyof ReleaseInput] !== v))
      : full;
    if (existing && Object.keys(patch).length === 0) return onClose();
    setSaving(true);
    const e = await onSave(patch);
    setSaving(false);
    if (e) setErr(e); else onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={existing ? "Edit release" : "New release"}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(7,42,32,.28)" }} />
      <form data-testid="release-dialog" onSubmit={(e) => { e.preventDefault(); void save(); }}
        className="relative flex w-full max-w-[456px] flex-col gap-4 rounded-[16px] bg-white p-[22px]" style={{ boxShadow: "0 8px 28px rgba(0,0,0,.12)" }}>
        <h2 className="m-0 text-[19px] font-bold" style={{ color: C.ink }}>{existing ? `Edit ${existing.version}` : "New release"}</h2>
        <div className="flex gap-3">
          <Field label="Version" className="w-[100px] flex-none">
            <input data-testid="release-version" value={version} onChange={(e) => setVersion(e.target.value)} className={INPUT} style={{ borderColor: C.line, color: C.ink }} />
          </Field>
          <Field label="Name" className="min-w-0 flex-1">
            <input data-testid="release-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tournaments" className={INPUT} style={{ borderColor: C.line, color: C.ink }} />
          </Field>
        </div>
        <div className="flex gap-3">
          <Field label="Start" className="min-w-0 flex-1">
            <input data-testid="release-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} style={{ borderColor: C.line, color: C.ink }} />
          </Field>
          <Field label="Out by" className="min-w-0 flex-1">
            <input data-testid="release-outby" type="date" value={outBy} onChange={(e) => setOutBy(e.target.value)} className={INPUT} style={{ borderColor: C.line, color: C.ink }} />
          </Field>
        </div>
        {err && <p className="m-0 text-[13px]" style={{ color: C.danger }} data-testid="release-error">{err}</p>}
        <div className="flex justify-end gap-2.5">
          <button type="button" onClick={onClose} className="rounded-[8px] border bg-white px-3.5 py-[9px] text-[13px] font-semibold" style={{ borderColor: C.line, color: C.ink }}>Cancel</button>
          <button type="submit" data-testid="release-save" disabled={saving} className="rounded-[8px] px-3.5 py-[9px] text-[13px] font-semibold text-white disabled:opacity-50" style={{ background: C.forest }}>
            {existing ? "Save" : "Create release"}
          </button>
        </div>
      </form>
    </div>
  );
}
const INPUT = "w-full rounded-[10px] border bg-white px-3 py-2.5 text-[14px] font-medium outline-none focus:border-[#2cdb87]";
function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-[12px] font-semibold" style={{ color: C.muted }}>{label}</span>
      {children}
    </label>
  );
}
