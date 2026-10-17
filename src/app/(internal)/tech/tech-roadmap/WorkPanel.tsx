"use client";

// The work panel (Figma 19433:44 reading, 19433:106 editing). Every field saves on change; there is
// no Save button. Name and description edit in place. "Who" is the assignee only (Ryan,
// ScrumLaunch or no one) and never touches owner_user_id, which is shown, read-only, as
// "Created by" in the footer.

import { useEffect, useRef, useState } from "react";
import type { KanbanCard, RoadmapAssignee } from "@/lib/kanban";
import type { CardPatch } from "@/lib/useKanbanBoard";
import { ASSIGNEE_LABEL, fmtDay, sortReleases, type Release } from "@/lib/roadmapReleases";
import { chicagoYmd } from "@/lib/weekBuckets";
import { ROADMAP_COLS } from "@/lib/roadmap";
import { C, PRIORITY_COLOR, descriptionOf, priorityOf } from "./roadmapUi";
import { DescriptionEditor, DescriptionView, RICH_CSS } from "./RichDescription";

export default function WorkPanel({ card, releases, isAdmin, createdBy, onClose, onPatch, onMove, onDelete }: {
  card: KanbanCard;
  releases: Release[];
  isAdmin: boolean;
  createdBy: string | null; // first name of owner_user_id, or null
  onClose: () => void;
  onPatch: (patch: CardPatch) => Promise<boolean>;
  onMove: (stage: string) => void;
  onDelete: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(card.title);
  const [nameError, setNameError] = useState(false);
  const cancelled = useRef(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A different card in the same panel starts clean.
  useEffect(() => { setEditingName(false); setEditingDesc(false); setConfirmDelete(false); setNameError(false); }, [card.id]);

  // Esc closes the panel, unless it is cancelling an edit (those handlers stop it first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !editingName && !editingDesc) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingName, editingDesc, onClose]);

  const startName = () => { if (!isAdmin) return; cancelled.current = false; setNameDraft(card.title); setNameError(false); setEditingName(true); };
  const commitName = (fromBlur: boolean) => {
    if (cancelled.current) return;
    const next = nameDraft.trim();
    if (!next) {
      // An empty name is refused. Enter keeps you in the box with a note; clicking away puts the old name back.
      if (fromBlur) { setEditingName(false); setNameError(false); } else setNameError(true);
      return;
    }
    setEditingName(false);
    if (next !== card.title) void onPatch({ title: next });
  };

  const desc = descriptionOf(card);
  const pri = priorityOf(card);
  const added = card.created_at ? chicagoYmd(card.created_at) : null;
  const addedLabel = added ? `${fmtDay(added)}${added.slice(0, 4) !== chicagoYmd(new Date().toISOString()).slice(0, 4) ? `, ${added.slice(0, 4)}` : ""}` : "";

  const setWho = (who: RoadmapAssignee | null) => {
    if (!isAdmin || (card.assignee ?? null) === who) return;
    void onPatch({ assignee: who });
  };

  return (
    <>
      <style>{RICH_CSS}</style>
      <div data-testid="scrim" onClick={onClose} className="fixed inset-0 z-[40]" style={{ background: "rgba(7,42,32,.18)" }} />
      <aside data-testid="work-panel" role="dialog" aria-label={card.title}
        className="fixed right-2 top-2 z-[41] flex max-h-[calc(100dvh-16px)] w-[476px] max-w-[calc(100vw-16px)] flex-col gap-5 overflow-y-auto rounded-[16px] bg-white px-[22px] py-5 sm:right-4 sm:top-4 sm:max-h-[calc(100dvh-32px)]"
        style={{ boxShadow: "0 8px 28px rgba(0,0,0,.12)" }}>

        {/* 1. name */}
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            {editingName ? (
              <input data-testid="name-input" autoFocus value={nameDraft} onChange={(e) => { setNameDraft(e.target.value); setNameError(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitName(false); }
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditingName(false); setNameError(false); }
                }}
                onBlur={() => commitName(true)}
                className="min-w-0 flex-1 rounded-[8px] border-2 px-2.5 py-1.5 text-[20px] font-bold outline-none" style={{ borderColor: nameError ? C.danger : C.accent, color: C.ink }} />
            ) : (
              <button type="button" data-testid="name" onClick={startName} disabled={!isAdmin}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left disabled:cursor-default" style={{ background: C.softer }}>
                <span className="min-w-0 flex-1 break-words text-[20px] font-bold leading-tight" style={{ color: C.ink }}>{card.title}</span>
                {isAdmin && <img src="/roadmap/pencil.svg" alt="" width={16} height={16} className="block flex-none" />}
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" data-testid="panel-close" className="flex-none px-1 py-2">
              <img src="/roadmap/close.svg" alt="" width={20} height={20} className="block" />
            </button>
          </div>
          {editingName && (
            <p className="m-0 text-[12px]" style={{ color: nameError ? C.danger : C.faint }} data-testid="name-hint">
              {nameError ? "A name is needed. Type one, or press Esc to keep the old one." : "Enter to save · Esc to cancel"}
            </p>
          )}
        </div>

        {/* 2. description */}
        {editingDesc ? (
          <DescriptionEditor md={desc} onDone={(next) => {
            setEditingDesc(false);
            if (next !== null && next !== desc.trim()) void onPatch({ data: { ...card.data, description: next } });
          }} />
        ) : (
          <div role={isAdmin ? "button" : undefined} tabIndex={isAdmin ? 0 : undefined} data-testid="description"
            onClick={(e) => { if (!isAdmin || (e.target as HTMLElement).closest("a")) return; setEditingDesc(true); }}
            onKeyDown={(e) => { if (isAdmin && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEditingDesc(true); } }}
            className={`flex flex-col gap-2 rounded-[10px] p-3 ${isAdmin ? "cursor-text" : ""}`} style={{ background: C.softer }}>
            <span className="text-[12px] font-semibold" style={{ color: C.muted }}>Description</span>
            {desc.trim()
              ? <DescriptionView md={desc} />
              : <span className="text-[14px]" style={{ color: C.faint }}>{isAdmin ? "Add a description" : "No description yet"}</span>}
          </div>
        )}

        {/* 3. status */}
        <div className="flex gap-[2px] rounded-[10px] p-[3px]" style={{ background: C.soft }} role="group" aria-label="Status">
          {ROADMAP_COLS.map((col) => {
            const on = card.stage === col.id;
            return (
              <button key={col.id} type="button" data-testid={`status-${col.id}`} aria-pressed={on} disabled={!isAdmin}
                onClick={() => { if (!on) onMove(col.id); }}
                className={`min-w-0 flex-1 rounded-[8px] px-1 py-2 text-[13px] ${on ? "font-semibold" : "font-medium"} disabled:cursor-default`}
                style={on ? { background: C.forest, color: C.white } : { color: C.ink }}>{col.title}</button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2.5">
          {/* 4. who */}
          <Row label="Who" extra={isAdmin && card.assignee ? (
            <button type="button" data-testid="who-clear" onClick={() => setWho(null)} className="text-[11px] font-semibold underline underline-offset-2" style={{ color: C.faint }}>Clear</button>
          ) : null}>
            <div className="flex flex-1 gap-[2px] rounded-[10px] p-[3px]" style={{ background: C.soft }} role="group" aria-label="Who">
              {(["ryan", "scrumlaunch"] as const).map((w) => {
                const on = card.assignee === w;
                return (
                  <button key={w} type="button" data-testid={`who-${w}`} aria-pressed={on} disabled={!isAdmin}
                    title={on ? "Click again to set No one yet" : undefined}
                    onClick={() => setWho(on ? null : w)}
                    className={`flex-1 rounded-[8px] py-2 text-[13px] ${on ? "font-semibold" : "font-medium"} disabled:cursor-default`}
                    style={on ? { background: C.forest, color: C.white } : { color: C.ink }}>{ASSIGNEE_LABEL[w]}</button>
                );
              })}
            </div>
          </Row>

          {/* 5. release */}
          <Row label="Release">
            <Select testid="release-select" value={card.release_id ?? ""} disabled={!isAdmin}
              onChange={(v) => { if (v !== (card.release_id ?? "")) void onPatch({ release_id: v || null }); }}>
              <option value="">No release</option>
              {sortReleases(releases).map((r) => <option key={r.id} value={r.id}>{r.version} {r.name}</option>)}
            </Select>
          </Row>

          {/* 6. priority */}
          <Row label="Priority">
            <Select testid="priority-select" value={pri ?? ""} disabled={!isAdmin} dot={pri ? PRIORITY_COLOR[pri] : undefined}
              onChange={(v) => { if (v && v !== pri) void onPatch({ data: { ...card.data, priority: v } }); }}>
              {!pri && <option value="" disabled>Pick one</option>}
              <option value="High">High</option><option value="Medium">Medium</option><option value="Low">Low</option>
            </Select>
          </Row>
        </div>

        {/* 7. footer */}
        <div className="flex items-center gap-2">
          <span data-testid="created-by" className="text-[12px]" style={{ color: C.faint }}>
            {createdBy ? `Created by ${createdBy} · ${addedLabel}` : `Added ${addedLabel}`}
          </span>
          <span className="flex-1" />
          {isAdmin && (confirmDelete ? (
            <span className="flex items-center gap-2 text-[13px]" style={{ color: C.danger }}>
              Delete this card?
              <button type="button" data-testid="delete-confirm" onClick={onDelete} className="rounded-[7px] px-2 py-1 font-semibold text-white" style={{ background: C.danger }}>Delete</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-[7px] border px-2 py-1 font-semibold" style={{ borderColor: C.line, color: C.muted }}>Cancel</button>
            </span>
          ) : (
            <button type="button" data-testid="delete" onClick={() => setConfirmDelete(true)} className="text-[13px] font-semibold" style={{ color: C.danger }}>Delete</button>
          ))}
        </div>
      </aside>
    </>
  );
}

function Row({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-[76px] flex-none flex-col items-start gap-0.5">
        <span className="text-[13px] font-medium" style={{ color: C.muted }}>{label}</span>
        {extra}
      </div>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Select({ value, onChange, disabled, dot, testid, children }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; dot?: string; testid: string; children: React.ReactNode;
}) {
  return (
    <label className="relative flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border px-2.5" style={{ borderColor: C.line }}>
      {dot && <span aria-hidden className="h-2 w-2 flex-none rounded-full" style={{ background: dot }} />}
      <select data-testid={testid} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 appearance-none bg-transparent py-[7px] pr-6 text-[14px] font-medium outline-none disabled:opacity-100" style={{ color: C.ink }}>
        {children}
      </select>
      <img src="/roadmap/chevron-down.svg" alt="" width={14} height={14} className="pointer-events-none absolute right-2.5 block" />
    </label>
  );
}
