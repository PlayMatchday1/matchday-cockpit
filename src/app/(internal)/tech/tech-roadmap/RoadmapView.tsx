"use client";

// Tech Roadmap 2.0 — App Roadmap + Clubhouse Roadmap, one component, two boards (Figma file
// 9TgSk4sYqq4nNoTH73wRRs, page "Clubhouse · Tech Roadmap 2.0"). Two tabs, Board (the default) and
// Releases, kept in the URL as ?tab=releases so a reload stays put.
//
// Cards read and write kanban_cards through the shared useKanbanBoard hook; releases go through
// useRoadmapReleases. A move between columns writes stage + sort_order + stage_entered_at (planMove
// in lib/roadmap.ts); a reorder inside a column writes sort_order only (planReorder). The database
// stamps done_at on the move into Done and clears it on the way out; the client mirrors that value
// only so the screen does not lag. Writes are gated on app_users.is_admin; anyone else gets a
// read-only page.
//
// "Who" is kanban_cards.assignee (Ryan, ScrumLaunch, or no one). owner_user_id is who ADDED the
// card: "+ Add" sets it to the signed-in user and nothing on this page ever changes it after.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { useKanbanBoard, type CardPatch } from "@/lib/useKanbanBoard";
import { firstName, ownerName, type KanbanCard, type RoadmapBoard } from "@/lib/kanban";
import { ROADMAP_COLS, roadmapBoardOf as boardOf, columnCards, planMove, planReorder } from "@/lib/roadmap";
import {
  deriveStats, doneGroups, doneOpenKey, estimateOf, fmtDay, fmtDayWithWeekday, fmtHours, parseHours, readOpen, shownDoneYmd,
  sortReleases, todayYmd, writeOpen,
  type Release,
} from "@/lib/roadmapReleases";
import { useRoadmapReleases } from "@/lib/useRoadmapReleases";
import { C, PRIORITY_COLOR, VersionChip, WhoChip, priorityOf } from "./roadmapUi";
import WorkPanel from "./WorkPanel";
import RoadmapReleases, { ReleaseDialog } from "./RoadmapReleases";

const BOARDS: Record<RoadmapBoard, { name: string; sub: string }> = {
  app: { name: "App Roadmap", sub: "Everything we are building for the player app, grouped by release." },
  clubhouse: { name: "Clubhouse Roadmap", sub: "Everything we are building for Clubhouse, our internal tools, grouped by release." },
};

const COL_DOT: Record<string, string> = {
  ideas: "/roadmap/col-ideas.svg", in_plan: "/roadmap/col-upnext.svg", in_progress: "/roadmap/col-working.svg", shipped: "/roadmap/col-done.svg",
};
const COLUMN_PREVIEW = 6;

type Who = "all" | "ryan" | "scrumlaunch";
type AddTarget = { stage: string; releaseId: string | null };

export default function RoadmapView({ board }: { board: RoadmapBoard }) {
  const { appUser } = useAuth();
  const isAdmin = !!appUser?.is_admin;
  const viewer = appUser?.id ?? "anon";
  const api = useKanbanBoard("tech_roadmap");
  const { cards, owners, loading, error } = api;
  const rel = useRoadmapReleases(board);
  const releases = rel.releases;

  // ── tab, in the URL ──
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab: "board" | "releases" = params.get("tab") === "releases" ? "releases" : "board";
  const setTab = (t: "board" | "releases") => {
    const next = new URLSearchParams(params.toString());
    if (t === "releases") next.set("tab", "releases"); else next.delete("tab");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // ── filters ──
  const [q, setQ] = useState("");
  const [who, setWho] = useState<Who>("all");
  const [releaseF, setReleaseF] = useState("");

  const [selId, setSelId] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  const [releaseDialog, setReleaseDialog] = useState<{ existing: Release | null } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // One clock per render; today is a calendar day in America/Chicago.
  const today = useMemo(() => todayYmd(), [cards, releases]); // eslint-disable-line react-hooks/exhaustive-deps
  const ownersById = useMemo(() => new Map(owners.map((o) => [o.id, o])), [owners]);
  const boardCards = useMemo(() => cards.filter((c) => boardOf(c) === board), [cards, board]);
  const releaseById = useMemo(() => new Map(releases.map((r) => [r.id, r])), [releases]);
  const stats = useMemo(() => deriveStats(boardCards, releases, today), [boardCards, releases, today]);

  // A release filter naming a release that is gone falls back to all.
  useEffect(() => { if (releaseF && !releaseById.has(releaseF)) setReleaseF(""); }, [releaseF, releaseById]);

  const matchesSearchWho = useCallback((c: KanbanCard) => {
    if (q && !c.title.toLowerCase().includes(q.toLowerCase())) return false;
    if (who !== "all" && c.assignee !== who) return false;
    return true;
  }, [q, who]);
  const passes = useCallback((c: KanbanCard) => matchesSearchWho(c) && (!releaseF || c.release_id === releaseF), [matchesSearchWho, releaseF]);

  // ── Done column blocks: open/closed per release per viewer ──
  // Before mount the default is used so the server render and the first client render agree;
  // localStorage is read only after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [openTick, setOpenTick] = useState(0);
  const doneAll = useMemo(() => columnCards(cards, board, "shipped"), [cards, board]);
  const defaultOpenKey = useMemo(() => doneGroups(doneAll, releases).find((g) => g.release)?.key ?? null, [doneAll, releases]);
  const isDoneOpen = (key: string) => {
    void openTick;
    const fallback = key === defaultOpenKey;
    return mounted ? readOpen(doneOpenKey(viewer, board, key), fallback) : fallback;
  };
  const setDoneOpen = useCallback((key: string, open: boolean) => {
    writeOpen(doneOpenKey(viewer, board, key), open);
    setOpenTick((n) => n + 1);
  }, [viewer, board]);

  // ── writes ──
  const moveCard = useCallback(async (id: string, toStage: string) => {
    if (!isAdmin) return;
    const nowIso = new Date().toISOString();
    const plan = planMove(cards, id, toStage, nowIso);
    if (plan.kind === "noop") return;
    // The stage clock comes from planMove; done_at mirrors the trigger in migration 0225.
    const ok = await api.updateCard(id, { ...plan.patch, done_at: toStage === "shipped" ? nowIso : null });
    if (ok && toStage === "shipped") {
      // Into Done: open the block it lands in, so the card does not disappear into a closed one.
      const card = cards.find((c) => c.id === id);
      setDoneOpen(card?.release_id && releaseById.has(card.release_id) ? card.release_id : "none", true);
    }
  }, [isAdmin, cards, api, releaseById, setDoneOpen]);

  // Inside a column: sort_order and nothing else (planReorder), so the stage clock does not move.
  const reorder = useCallback(async (id: string, beforeId: string | null) => {
    if (!isAdmin) return;
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const plan = planReorder(columnCards(cards, boardOf(card), card.stage), id, beforeId);
    if (plan.kind === "noop") return;
    await api.updateCard(id, plan.patch);
  }, [isAdmin, cards, api]);

  const handleDrop = useCallback((colId: string, beforeId: string | null) => {
    const id = dragId.current;
    dragId.current = null;
    setDragOver(null);
    if (!id || !isAdmin) return;
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    if (card.stage === colId) void reorder(id, beforeId);
    else void moveCard(id, colId);
  }, [cards, isAdmin, reorder, moveCard]);

  const patchCard = useCallback(async (id: string, patch: CardPatch): Promise<boolean> => {
    if (!isAdmin) return false;
    return api.updateCard(id, patch);
  }, [isAdmin, api]);

  const createWork = async (title: string, hours: number | null, target: AddTarget) => {
    const id = await api.createCard({
      title, stage: target.stage, board, release_id: target.releaseId,
      owner_user_id: appUser?.id ?? null, // "Created by": whoever is signed in
      data: { priority: "Medium", description: "", planned_date: null, ...(hours !== null ? { estimated_hours: hours } : {}) },
    });
    setAdding(null);
    if (id) setSelId(id);
  };

  if ((loading && cards.length === 0) || (rel.loading && releases.length === 0 && !rel.error)) {
    return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading roadmap…</div>;
  }

  const b = BOARDS[board];
  const sel = selId ? boardCards.find((c) => c.id === selId) ?? null : null;
  const creator = sel?.owner_user_id ? ownersById.get(sel.owner_user_id) : undefined;
  const sortedReleases = sortReleases(releases);
  const writeError = error || rel.error;

  return (
    <div className="min-w-0" style={{ color: C.ink }}>
      {writeError && (
        <div className="mb-3 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#f0bda9", background: "#fdeae4", color: "#a8391a" }}>
          Something did not save or load: {writeError}
        </div>
      )}

      {/* title row */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <div className="min-w-0">
          <h1 className="m-0 text-[26px] font-bold leading-tight" style={{ color: C.ink }}>{b.name}</h1>
          <p className="m-0 mt-1 text-[13px]" style={{ color: C.muted }}>{b.sub}</p>
        </div>
        <span className="flex-1" />
        {isAdmin && (
          <div className="flex gap-2.5">
            <button type="button" data-testid="new-release" onClick={() => setReleaseDialog({ existing: null })}
              className="rounded-[8px] border bg-white px-3.5 py-[9px] text-[13px] font-semibold" style={{ borderColor: C.line, color: C.ink }}>+ New release</button>
            <button type="button" data-testid="add-work" onClick={() => setAdding({ stage: "ideas", releaseId: null })}
              className="rounded-[8px] px-3.5 py-[9px] text-[13px] font-semibold text-white" style={{ background: C.forest }}>+ Add work</button>
          </div>
        )}
      </div>

      {/* tabs */}
      <div className="mb-5 flex gap-7 border-b" style={{ borderColor: C.line }} role="tablist">
        <TabButton active={tab === "board"} onClick={() => setTab("board")} label="Board" count={`${boardCards.length} ${boardCards.length === 1 ? "item" : "items"}`} testid="tab-board" />
        <TabButton active={tab === "releases"} onClick={() => setTab("releases")} label="Releases" count={`${releases.length} ${releases.length === 1 ? "release" : "releases"}`} testid="tab-releases" />
      </div>

      <StatsRow stats={stats} />

      {/* filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <input data-testid="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search work…"
          className="min-h-[38px] min-w-[200px] flex-1 rounded-[10px] border bg-white px-3.5 text-[13px] outline-none" style={{ borderColor: C.line, color: C.ink }} />
        <div className="flex gap-[2px] rounded-[10px] border bg-white p-[3px]" style={{ borderColor: C.line }} role="group" aria-label="Who">
          {([["all", "Everyone"], ["ryan", "Ryan"], ["scrumlaunch", "ScrumLaunch"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`who-filter-${k}`} aria-pressed={who === k} onClick={() => setWho(k)}
              className={`rounded-[8px] px-3 py-1.5 text-[13px] ${who === k ? "font-semibold" : "font-medium"}`}
              style={who === k ? { background: C.forest, color: C.white } : { color: C.ink }}>{label}</button>
          ))}
        </div>
        {tab === "board" && (
          <label className="relative flex items-center rounded-[10px] border bg-white" style={{ borderColor: C.line }}>
            <select data-testid="release-filter" value={releaseF} onChange={(e) => setReleaseF(e.target.value)}
              className="appearance-none bg-transparent py-[9px] pl-3 pr-8 text-[13px] font-medium outline-none" style={{ color: C.ink }}>
              <option value="">All releases</option>
              {sortedReleases.map((r) => <option key={r.id} value={r.id}>{r.version} {r.name}</option>)}
            </select>
            <img src="/roadmap/chevron-down.svg" alt="" width={14} height={14} className="pointer-events-none absolute right-3 block" />
          </label>
        )}
      </div>

      {tab === "board" ? (
        <>
          <div className="grid grid-cols-1 items-start gap-3.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="board">
            {ROADMAP_COLS.map((col) => {
              const all = columnCards(cards, board, col.id);
              const vis = all.filter(passes);
              const isDone = col.id === "shipped";
              const showAll = !!expanded[col.id];
              const shown = isDone || showAll ? vis : vis.slice(0, COLUMN_PREVIEW);
              const hidden = vis.length - shown.length;
              const groups = isDone ? doneGroups(vis, releases) : [];
              const cardProps = (c: KanbanCard) => ({
                c, release: c.release_id ? releaseById.get(c.release_id) ?? null : null, selected: selId === c.id,
                doneDay: c.stage === "shipped" ? shownDoneYmd(c, releaseById, today) : null,
                onOpen: () => setSelId(c.id),
                onDragStart: () => { dragId.current = c.id; },
                onDragEnd: () => { dragId.current = null; setDragOver(null); },
                onDropBefore: () => handleDrop(col.id, c.id),
                onDragOverCard: () => setDragOver(col.id),
              });
              return (
                <div key={col.id} data-col={col.id} data-testid={`col-${col.id}`}
                  onDragOver={(e) => { if (isAdmin && dragId.current) { e.preventDefault(); setDragOver(col.id); } }}
                  onDragLeave={() => setDragOver((d) => (d === col.id ? null : d))}
                  onDrop={(e) => { e.preventDefault(); handleDrop(col.id, null); }}
                  className="flex min-w-0 flex-col gap-2.5 rounded-[14px] px-3 py-3.5"
                  style={{ background: C.column, outline: dragOver === col.id ? `2px solid ${C.accent}` : "none" }}>
                  <div className="flex items-center gap-2 px-1">
                    <img src={COL_DOT[col.id]} alt="" width={10} height={10} className="block flex-none" />
                    <span className="text-[15px] font-bold" style={{ color: C.ink }}>{col.title}</span>
                    <span className="flex-1" />
                    <span data-testid={`colcount-${col.id}`} className="rounded-full bg-white px-[9px] py-[3px] text-[11px] font-semibold" style={{ color: C.muted }}>{vis.length}</span>
                  </div>

                  {vis.length === 0 && (
                    <div className="px-1 py-3 text-[12px]" style={{ color: C.muted }}>{all.length ? "Nothing here matches the filters." : "Nothing here yet."}</div>
                  )}

                  {isDone
                    ? groups.map((g) => {
                        const open = isDoneOpen(g.key);
                        return (
                          <div key={g.key} data-testid="done-group" data-group={g.release ? g.release.version : "none"} data-open={open ? "1" : "0"} className="flex flex-col rounded-[12px] bg-white">
                            <button type="button" data-testid="done-group-header" aria-expanded={open} onClick={() => setDoneOpen(g.key, !open)}
                              className="flex w-full items-start gap-2 py-2.5 pl-2.5 pr-3 text-left [&>img]:mt-[3px]">
                              <img src={open ? "/roadmap/group-open.svg" : "/roadmap/group-closed.svg"} alt="" width={14} height={14} className="block flex-none" />
                              {g.release && <VersionChip v={g.release.version} />}
                              <span className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-tight" style={{ color: C.ink }}>{g.release ? g.release.name : "No release"}</span>
                              <span data-testid="done-group-count" className="flex-none rounded-full px-[9px] py-[3px] text-[11px] font-semibold" style={{ background: C.mint, color: C.forest }}>{g.cards.length}</span>
                            </button>
                            {open && (
                              <div className="flex flex-col gap-2 px-2 pb-2">
                                {g.cards.map((c) => <Card key={c.id} {...cardProps(c)} draggable={isAdmin} inDoneGroup />)}
                              </div>
                            )}
                          </div>
                        );
                      })
                    : shown.map((c) => <Card key={c.id} {...cardProps(c)} draggable={isAdmin} />)}

                  <div className="flex items-center px-1 pt-1">
                    {!isDone && vis.length > COLUMN_PREVIEW && (
                      <button type="button" data-testid={`more-${col.id}`} onClick={() => setExpanded((e) => ({ ...e, [col.id]: !showAll }))}
                        className="text-[13px] font-semibold" style={{ color: C.link }}>{showAll ? "Show less" : `Show ${hidden} more`}</button>
                    )}
                    <span className="flex-1" />
                    {isAdmin && (
                      <button type="button" data-testid={`add-${col.id}`} onClick={() => setAdding({ stage: col.id, releaseId: releaseF || null })}
                        className="text-[13px] font-semibold" style={{ color: C.link }}>+ Add</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div data-testid="legend" className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] font-medium" style={{ color: C.muted }}>
            <span>Left edge shows priority:</span>
            {(["High", "Medium", "Low"] as const).map((p) => (
              <span key={p} className="flex items-center gap-1.5"><span className="h-3.5 w-[3px]" style={{ background: PRIORITY_COLOR[p] }} />{p}</span>
            ))}
            {isAdmin && <span className="font-normal">Drag a card to another column to change its status.</span>}
          </div>
        </>
      ) : (
        <RoadmapReleases board={board} cards={boardCards} releases={releases} today={today} viewer={viewer} isAdmin={isAdmin}
          passes={matchesSearchWho} onOpenCard={setSelId}
          onAddWork={(releaseId) => setAdding({ stage: releaseId ? "in_plan" : "ideas", releaseId })}
          onEditRelease={(r) => setReleaseDialog({ existing: r })} />
      )}

      {sel && (
        <WorkPanel card={sel} releases={releases} isAdmin={isAdmin}
          createdBy={creator ? firstName(ownerName(creator)) : null}
          onClose={() => setSelId(null)}
          onPatch={(patch) => patchCard(sel.id, patch)}
          onMove={(stage) => void moveCard(sel.id, stage)}
          onDelete={async () => { if (isAdmin) { await api.deleteCard(sel.id); setSelId(null); } }} />
      )}

      {adding && isAdmin && (
        <AddWorkDialog target={adding} release={adding.releaseId ? releaseById.get(adding.releaseId) ?? null : null}
          onClose={() => setAdding(null)} onCreate={(title, hours) => createWork(title, hours, adding)} />
      )}

      {releaseDialog && isAdmin && (
        <ReleaseDialog existing={releaseDialog.existing} releases={releases} today={today}
          onClose={() => setReleaseDialog(null)}
          onSave={(input) => releaseDialog.existing
            ? rel.updateRelease(releaseDialog.existing.id, input)
            : rel.createRelease(input as Required<typeof input>)} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, count, testid }: { active: boolean; onClick: () => void; label: string; count: string; testid: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} data-testid={testid} onClick={onClick}
      className="-mb-px flex items-center gap-2 border-b-[3px] pb-3 pt-1" style={{ borderColor: active ? C.forest : "transparent" }}>
      <span className={`text-[15px] ${active ? "font-bold" : "font-medium"}`} style={{ color: active ? C.ink : C.muted }}>{label}</span>
      <span className="rounded-full px-[9px] py-[3px] text-[11px] font-semibold" style={active ? { background: C.mint, color: C.forest } : { background: C.grey, color: C.muted }}>{count}</span>
    </button>
  );
}

function StatsRow({ stats }: { stats: ReturnType<typeof deriveStats> }) {
  const { next, working, scrum, outThisYear } = stats;
  const workingSub = [`${working.ryan} Ryan`, `${working.scrumlaunch} ScrumLaunch`, ...(working.none ? [`${working.none} no one yet`] : [])].join(" · ");
  const scrumSub = scrum.total === 0 ? "Nothing waiting"
    : scrum.releases === 0 ? "Not in a release yet"
    : `Across ${scrum.releases} ${scrum.releases === 1 ? "release" : "releases"}${scrum.noRelease ? `, ${scrum.noRelease} not in one` : ""}`;
  const { last, lastDay } = outThisYear;
  return (
    <div data-testid="stats" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="NEXT RELEASE" big={next ? `${next.version} ${next.name}`.trim() : "None planned"} small={next ? `Target ${fmtDayWithWeekday(next.out_by)}` : "Add a release to see it here"} testid="stat-next" bigSize={18} />
      <Stat label="BEING WORKED ON" big={String(working.total)} small={workingSub} testid="stat-working" />
      <Stat label="WAITING ON SCRUMLAUNCH" big={String(scrum.total)} small={scrumSub} testid="stat-scrum" />
      <Stat label="OUT THIS YEAR" big={String(outThisYear.total)} small={last && lastDay ? `Last one: ${last.title}, ${fmtDay(lastDay)}` : "Nothing out yet this year"} testid="stat-out" />
    </div>
  );
}
function Stat({ label, big, small, testid, bigSize = 24 }: { label: string; big: string; small: string; testid: string; bigSize?: number }) {
  return (
    <div data-testid={testid} className="flex min-w-0 flex-col gap-1 rounded-[12px] bg-white px-4 py-3.5">
      <span className="text-[10px] font-semibold tracking-[0.6px]" style={{ color: C.faint }}>{label}</span>
      <span data-testid={`${testid}-value`} className="break-words font-bold leading-tight" style={{ color: C.ink, fontSize: bigSize }}>{big}</span>
      <span data-testid={`${testid}-sub`} className="break-words text-[12px]" style={{ color: C.muted }}>{small}</span>
    </div>
  );
}

function Card({ c, release, selected, draggable, inDoneGroup, doneDay, onOpen, onDragStart, onDragEnd, onDropBefore, onDragOverCard }: {
  c: KanbanCard; release: Release | null; selected: boolean; draggable: boolean; inDoneGroup?: boolean;
  doneDay: string | null; // shownDoneYmd, worked out by the board so every reader agrees
  onOpen: () => void; onDragStart: () => void; onDragEnd: () => void; onDropBefore: () => void; onDragOverCard: () => void;
}) {
  const done = c.stage === "shipped";
  const pri = priorityOf(c);
  const hours = estimateOf(c);
  return (
    <div data-testid="card" data-card-id={c.id} data-stage={c.stage} role="button" tabIndex={0} aria-label={`Open ${c.title}`}
      draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragOver={(e) => { if (!draggable) return; e.preventDefault(); e.stopPropagation(); onDragOverCard(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropBefore(); }}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="flex cursor-pointer flex-col gap-2.5 rounded-[12px] p-3"
      style={{
        background: inDoneGroup ? C.softer : C.white,
        borderLeft: done ? undefined : `3px solid ${pri ? PRIORITY_COLOR[pri] : C.line}`,
        boxShadow: selected ? `0 0 0 2px ${C.accent}` : undefined,
      }}>
      {/* The whole title, wrapped to as many lines as it takes: never clamped or cut. */}
      <span data-testid="card-title" className={`min-w-0 whitespace-normal break-words text-[14px] leading-snug ${done ? "font-medium" : "font-semibold"}`} style={{ color: done ? C.muted : C.ink }}>{c.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {release && !inDoneGroup && <VersionChip v={release.version} />}
        <WhoChip who={c.assignee} />
        {hours !== null && <span data-testid="card-hours" title="Estimate" className="text-[11px] font-semibold" style={{ color: C.faint }}>{fmtHours(hours)}</span>}
        <span className="flex-1" />
        {doneDay && <span data-testid="card-done-date" className="text-[11px] font-semibold" style={{ color: C.faint }}>{fmtDay(doneDay)}</span>}
      </span>
    </div>
  );
}

function AddWorkDialog({ target, release, onClose, onCreate }: {
  target: AddTarget; release: Release | null; onClose: () => void; onCreate: (title: string, hours: number | null) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [hoursText, setHoursText] = useState("");
  const [busy, setBusy] = useState(false);
  const hours = parseHours(hoursText);
  const where = release ? `to ${release.version} ${release.name}`.trim() : `in ${ROADMAP_COLS.find((x) => x.id === target.stage)?.title ?? "Ideas"}`;
  const submit = async () => {
    const t = title.trim();
    if (!t || busy || hours === undefined) return;
    setBusy(true);
    await onCreate(t, hours);
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add work">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(7,42,32,.28)" }} />
      <form data-testid="add-dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="relative flex w-full max-w-[456px] flex-col gap-4 rounded-[16px] bg-white p-[22px]" style={{ boxShadow: "0 8px 28px rgba(0,0,0,.12)" }}>
        <div>
          <h2 className="m-0 text-[19px] font-bold" style={{ color: C.ink }}>Add work</h2>
          <p className="m-0 mt-1 text-[13px]" style={{ color: C.muted }}>Adding {where}. You can set the rest once it is added.</p>
        </div>
        <input data-testid="add-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is the work?"
          className="w-full rounded-[10px] border bg-white px-3 py-2.5 text-[14px] outline-none focus:border-[#2cdb87]" style={{ borderColor: C.line, color: C.ink }} />
        <label className="flex items-center gap-2.5 text-[13px] font-medium" style={{ color: C.muted }}>
          Estimate
          <input data-testid="add-hours" value={hoursText} onChange={(e) => setHoursText(e.target.value)} inputMode="decimal" placeholder="Optional"
            className="w-[110px] rounded-[10px] border bg-white px-3 py-2 text-[14px] outline-none focus:border-[#2cdb87]" style={{ borderColor: hours === undefined ? C.danger : C.line, color: C.ink }} />
          hours
          {hours === undefined && <span style={{ color: C.danger }}>Use a number, like 8 or 1.5</span>}
        </label>
        <div className="flex justify-end gap-2.5">
          <button type="button" onClick={onClose} className="rounded-[8px] border bg-white px-3.5 py-[9px] text-[13px] font-semibold" style={{ borderColor: C.line, color: C.ink }}>Cancel</button>
          <button type="submit" data-testid="add-save" disabled={!title.trim() || busy || hours === undefined} className="rounded-[8px] px-3.5 py-[9px] text-[13px] font-semibold text-white disabled:opacity-40" style={{ background: C.forest }}>Add</button>
        </div>
      </form>
    </div>
  );
}
