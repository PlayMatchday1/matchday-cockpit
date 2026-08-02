"use client";

// Field Pipeline board (mockup docs/mockups/fieldpipeline-v1.html). A dedicated
// renderer for board_type='field_pipeline' so the SHARED KanbanBoard (still
// used by /tech/tech-roadmap) is untouched — tech-roadmap renders byte-
// identical. Reuses the useKanbanBoard data layer + KanbanCardModal for CRUD.
//
// AGE is shown as a proven LOWER BOUND on time-in-stage ("≥ Nd in stage") for
// the pre-commitment stages (Backlog / Contacted / Negotiation). kanban_cards
// has no per-stage entry timestamp yet, but updated_at is DB-trigger-maintained
// (migration 0066), so it moved when stage last changed and only later — making
// (now - updated_at) a bound that can under-report but never over-report. A card
// past a threshold is therefore certainly past it. Once the stage_entered_at
// migration lands, stageAge() returns the EXACT value and the "≥" is dropped —
// no change needed here (the board reads one helper). See src/lib/kanban.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKanbanBoard } from "@/lib/useKanbanBoard";
import KanbanCardModal, { type ModalState } from "./KanbanCardModal";
import {
  FIELD_PIPELINE_STAGES,
  cardCity,
  cityLabel,
  cardOwnerLabel,
  ownerName,
  stageAge,
  ageBand,
  type KanbanCard,
  type ChecklistItem,
  type KanbanOwner,
} from "@/lib/kanban";

// Exactly the nine city hues from the mockup's CITY map, keyed by display name.
// A city not in this map falls back to the neutral — never a generated hue, and
// never a status colour (red/amber are reserved for state).
const CITY_HUE: Record<string, string> = {
  Austin: "#3f7d23",
  Dallas: "#3741ae",
  Houston: "#b04583",
  "San Antonio": "#8c421d",
  Philadelphia: "#457ab0",
  Atlanta: "#ae7337",
  "St. Louis": "#37aea4",
  "Oklahoma City": "#791d8c",
  "El Paso": "#7d8c2a",
};
const NEUTRAL_HUE = "#9aa8a1";
const cityHue = (displayName: string) => CITY_HUE[displayName] ?? NEUTRAL_HUE;

const COLLAPSE_KEY = "fieldpipeline:collapsed:v1";
const GROUPS_KEY = "fieldpipeline:shutgroups:v1";

function readLS(key: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
function writeLS(key: string, v: Record<string, boolean>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

type OwnerInfo = { name: string; initials: string; unlinked: boolean } | null;

export default function FieldPipelineBoard() {
  const api = useKanbanBoard("field_pipeline");
  const { cards, checklists, owners, loading, error } = api;

  const [modal, setModal] = useState<ModalState | null>(null);
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [todoFilter, setTodoFilter] = useState(false);
  const [group, setGroup] = useState(true);
  const [showTodos, setShowTodos] = useState(true);
  const [collapsedStored, setCollapsedStored] = useState<Record<string, boolean>>({});
  const [shutGroups, setShutGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCollapsedStored(readLS(COLLAPSE_KEY));
    setShutGroups(readLS(GROUPS_KEY));
  }, []);

  // Drag-and-drop (native HTML5, same interaction model as the shared
  // KanbanBoard — no drag library). A drop changes ONLY the card's stage; city,
  // owner, and order are untouched, so a card always lands in its own city group
  // in the destination column.
  const draggingId = useRef<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const ownersById = useMemo(() => new Map(owners.map((o: KanbanOwner) => [o.id, o])), [owners]);

  // Every person shown on the board — card owners AND to-do assignees — so we
  // can decide one initials strategy for all avatars.
  const allPersonNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of cards) {
      if (c.owner_user_id && ownersById.has(c.owner_user_id)) s.add(ownerName(ownersById.get(c.owner_user_id)));
      else { const l = cardOwnerLabel(c); if (l) s.add(l); }
    }
    for (const arr of Object.values(checklists)) for (const it of arr as ChecklistItem[]) {
      if (it.owner_user_id && ownersById.has(it.owner_user_id)) s.add(ownerName(ownersById.get(it.owner_user_id)));
    }
    return s;
  }, [cards, checklists, ownersById]);
  // Two-letter initials for everyone iff two distinct people share a first
  // letter (e.g. Michael/Miguel/Mike all "M") — a single letter would be an
  // ambiguous badge. Otherwise one letter.
  const twoLetter = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of allPersonNames) {
      const f = (n.trim()[0] ?? "").toUpperCase();
      if (seen.has(f) && seen.get(f) !== n) return true;
      seen.set(f, n);
    }
    return false;
  }, [allPersonNames]);
  const initialsFor = useCallback((name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!twoLetter) return (parts[0]?.[0] ?? "?").toUpperCase();
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (name.trim().slice(0, 2) || "?").toUpperCase();
  }, [twoLetter]);

  const ownerInfo = useCallback(
    (card: KanbanCard): OwnerInfo => {
      if (card.owner_user_id && ownersById.has(card.owner_user_id)) {
        const nm = ownerName(ownersById.get(card.owner_user_id));
        return { name: nm, initials: initialsFor(nm), unlinked: false };
      }
      const label = cardOwnerLabel(card);
      if (label) return { name: label, initials: initialsFor(label), unlinked: true };
      return null;
    },
    [ownersById, initialsFor],
  );
  // A to-do's assignee (separate from the card owner). null → render "Unassigned".
  const assigneeInfo = useCallback(
    (item: ChecklistItem): { name: string; initials: string } | null => {
      if (item.owner_user_id && ownersById.has(item.owner_user_id)) {
        const nm = ownerName(ownersById.get(item.owner_user_id));
        return { name: nm, initials: initialsFor(nm) };
      }
      return null;
    },
    [ownersById, initialsFor],
  );
  const cityOf = (card: KanbanCard) => cityLabel(cardCity(card));
  const openTodos = (card: KanbanCard) => (checklists[card.id] ?? []).filter((i: ChecklistItem) => !i.done).length;
  const doneTodos = (card: KanbanCard) => (checklists[card.id] ?? []).filter((i: ChecklistItem) => i.done).length;

  // ---- derived totals (every value from the rows, none typed) ----
  const totals = useMemo(() => {
    const cities = new Set<string>();
    const ownerSet = new Set<string>();
    let todos = 0;
    for (const c of cards) {
      const cc = cardCity(c);
      if (cc) cities.add(cc);
      const oi = ownerInfo(c);
      if (oi) ownerSet.add(oi.name);
      todos += openTodos(c);
    }
    return { fields: cards.length, cities: cities.size, owners: ownerSet.size, todos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, checklists, ownersById]);

  const filtering = !!(search.trim() || ownerFilter || cityFilter || todoFilter);
  const matches = useCallback(
    (c: KanbanCard) => {
      const oi = ownerInfo(c);
      const q = search.trim().toLowerCase();
      if (q) {
        const hay = `${c.title} ${cityOf(c)} ${oi?.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (ownerFilter && (oi?.name ?? "") !== ownerFilter) return false;
      if (cityFilter && cardCity(c) !== cityFilter) return false;
      if (todoFilter && openTodos(c) === 0) return false;
      return true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [search, ownerFilter, cityFilter, todoFilter, ownerInfo, checklists],
  );

  const byStage = useMemo(() => {
    const m = new Map<string, KanbanCard[]>();
    for (const st of FIELD_PIPELINE_STAGES) m.set(st.id, []);
    for (const c of cards) (m.get(c.stage) ?? m.set(c.stage, []).get(c.stage)!).push(c);
    return m;
  }, [cards]);

  const isCollapsed = (stageId: string, rawCount: number) =>
    stageId in collapsedStored ? collapsedStored[stageId] : stageId === "archived" || rawCount === 0;
  const toggleCol = (stageId: string, rawCount: number) => {
    const next = { ...collapsedStored, [stageId]: !isCollapsed(stageId, rawCount) };
    setCollapsedStored(next);
    writeLS(COLLAPSE_KEY, next);
  };
  const toggleGroup = (key: string) => {
    const next = { ...shutGroups, [key]: !shutGroups[key] };
    setShutGroups(next);
    writeLS(GROUPS_KEY, next);
  };

  // Move a card to a new stage (via drag OR the modal's stage selector). Only
  // `stage` changes. If the destination column is collapsed, open it first so
  // the card never disappears into a 46px rail. On server failure updateCard
  // rolls the optimistic move back; we surface that with a toast.
  const moveCardToStage = useCallback(
    async (cardId: string, stageId: string) => {
      const moving = cards.find((c) => c.id === cardId);
      if (!moving || moving.stage === stageId) return;
      setCollapsedStored((prev) => {
        const rawCount = cards.filter((c) => c.stage === stageId).length;
        const wasColl =
          stageId in prev ? prev[stageId] : stageId === "archived" || rawCount === 0;
        if (!wasColl) return prev;
        const next = { ...prev, [stageId]: false };
        writeLS(COLLAPSE_KEY, next);
        return next;
      });
      const ok = await api.updateCard(cardId, { stage: stageId });
      if (!ok) setToast("Couldn't move that field — it's back where it was.");
    },
    [cards, api],
  );

  const onColumnDrop = (stageId: string) => {
    const id = draggingId.current;
    draggingId.current = null;
    setDragOverStage(null);
    if (id) void moveCardToStage(id, stageId);
  };

  const ownerOptions = useMemo(
    () => [...new Set(cards.map((c) => ownerInfo(c)?.name).filter(Boolean) as string[])].sort(),
    [cards, ownerInfo],
  );
  const cityOptions = useMemo(
    () => [...new Set(cards.map((c) => cardCity(c)).filter(Boolean) as string[])].sort((a, b) => cityLabel(a).localeCompare(cityLabel(b))),
    [cards],
  );
  const existingMarkets = cityOptions;

  const clearFilters = () => {
    setSearch("");
    setOwnerFilter("");
    setCityFilter("");
    setTodoFilter(false);
  };

  if (loading && cards.length === 0) {
    return <div className="p-8 text-sm" style={{ color: "#6d7b74" }}>Loading pipeline…</div>;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ color: "#12241d" }}>
      {error && (
        <div className="mx-1 mt-1 rounded-xl border p-3 text-[12.5px]" style={{ borderColor: "#f0bda9", background: "#fdeae4", color: "#a8391a" }}>{error}</div>
      )}
      {/* head */}
      <div className="flex-none px-1 pt-1">
        <div className="flex items-start gap-3.5">
          <h1 className="m-0 border-l-[3px] pl-[11px] text-[20px] font-[750] leading-[1.25] tracking-[-0.3px]" style={{ borderColor: "#35c77f" }}>
            Field Pipeline
            <i className="mt-0.5 block text-[12.5px] font-[450] not-italic" style={{ color: "#6d7b74" }}>
              Every field by stage, grouped by city and owner.
            </i>
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <ToggleBtn on={group} onClick={() => setGroup((v) => !v)} label={group ? "Grouped by city" : "Flat list"} />
            <ToggleBtn on={showTodos} onClick={() => setShowTodos((v) => !v)} label={showTodos ? "To-dos shown" : "To-dos hidden"} />
            <button
              type="button"
              onClick={() => setModal({ mode: "create" })}
              className="flex h-[34px] items-center gap-1.5 rounded-[9px] border px-3.5 text-[12.5px] font-semibold"
              style={{ background: "#0d3b2e", borderColor: "#0d3b2e", color: "#eafff4" }}
            >
              + New card
            </button>
          </div>
        </div>

        {/* chip strip — only facts the board doesn't already print (no Confirmed count) */}
        <div className="mt-3 flex flex-wrap items-center gap-[7px]">
          <Chip><b>{totals.fields}</b> fields</Chip>
          <Sep />
          <Chip><b>{totals.cities}</b> {totals.cities === 1 ? "city" : "cities"}</Chip>
          <Sep />
          <Chip><b>{totals.owners}</b> {totals.owners === 1 ? "owner" : "owners"}</Chip>
          {totals.todos > 0 && (
            <button
              type="button"
              onClick={() => setTodoFilter((v) => !v)}
              aria-pressed={todoFilter}
              className="flex h-[27px] items-center gap-[7px] rounded-full border px-[11px] text-[12px] transition"
              style={
                todoFilter
                  ? { background: "#bfe4cf", borderColor: "#8fcbaa", color: "#12704a", boxShadow: "inset 0 1px 2px rgba(6,60,38,.13)" }
                  : { background: "#e0f2e7", borderColor: "#c9e8d8", color: "#12704a" }
              }
            >
              <b className="font-bold">{totals.todos}</b> open {totals.todos === 1 ? "to-do" : "to-dos"}
            </button>
          )}
          {/* aging/stalled chips intentionally absent — no stage-entry timestamp (R3b) */}
        </div>

        {/* filter row */}
        <div className="mb-3 mt-[11px] flex items-center gap-[9px]">
          <div className="relative max-w-[520px] flex-1">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" fill="none" stroke="#9aa8a1" strokeWidth={2.2}>
              <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search field, city, or owner…"
              className="h-9 w-full rounded-[9px] border pl-[34px] pr-3 text-[13px] outline-none focus:border-[#35c77f]"
              style={{ background: "#ffffff", borderColor: "#e2eae5", color: "#12241d" }}
            />
          </div>
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="h-9 rounded-[9px] border px-[11px] text-[12.5px]" style={{ background: "#ffffff", borderColor: "#e2eae5", color: "#2b3d35" }}>
            <option value="">All owners</option>
            {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} className="h-9 rounded-[9px] border px-[11px] text-[12.5px]" style={{ background: "#ffffff", borderColor: "#e2eae5", color: "#2b3d35" }}>
            <option value="">All cities</option>
            {cityOptions.map((c) => <option key={c} value={c}>{cityLabel(c)}</option>)}
          </select>
          {filtering && (
            <button type="button" onClick={clearFilters} className="cursor-pointer p-1.5 text-[12px] underline" style={{ color: "#6d7b74" }}>Clear filters</button>
          )}
        </div>
      </div>

      {/* board */}
      <div className="flex min-h-0 flex-1 pb-4">
        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-1.5" style={{ minWidth: 0 }}>
          {FIELD_PIPELINE_STAGES.map((st, i) => {
            const all = byStage.get(st.id) ?? [];
            const show = all.filter(matches);
            const coll = isCollapsed(st.id, all.length);
            const headerCount =
              filtering && show.length !== all.length
                ? { text: `${show.length} of ${all.length}`, filt: true }
                : { text: String(all.length), filt: false };
            // A collapsed rail prints its FILTERED count during a filter, never raw.
            const railCount = filtering ? show.length : all.length;

            const dragOver = dragOverStage === st.id;

            if (coll) {
              return (
                <section
                  key={st.id}
                  onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== st.id) setDragOverStage(st.id); }}
                  onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverStage((s) => (s === st.id ? null : s)); }}
                  onDrop={(e) => { e.preventDefault(); onColumnDrop(st.id); }}
                  className="flex flex-none flex-col rounded-[12px] border transition"
                  style={{ width: 46, background: dragOver ? "#e0f2e7" : "#f6f9f7", borderColor: dragOver ? "#35c77f" : "#e6ebe8" }}
                >
                  {dragOver && <div aria-hidden className="mx-1 mt-1 rounded-[6px] py-1 text-center text-[9px] font-bold" style={{ background: "#bfe4cf", color: "#12704a" }}>Drop</div>}
                  <div className="flex h-full flex-col items-center gap-2 py-2.5">
                    <button type="button" onClick={() => toggleCol(st.id, all.length)} aria-expanded={false} title={`Expand ${st.title}`} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px]" style={{ color: "#7d8c84" }}>
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 rotate-180" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                    </button>
                    <span className="flex h-[19px] w-[19px] items-center justify-center rounded-[6px] text-[11px] font-bold" style={{ background: "#0d3b2e", color: "#d8f5e7" }}>{i + 1}</span>
                    <span className="mt-2 rounded-full border px-1.5 py-0.5 text-[11px] font-bold" style={filtering && show.length ? { background: "#e0f2e7", borderColor: "#c9e8d8", color: "#12704a" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#54655c" }}>{railCount}</span>
                    <span className="mt-2 whitespace-nowrap text-[12px] font-bold tracking-[-0.1px] [writing-mode:vertical-rl]" style={{ color: "#33463e" }}>{st.title}</span>
                  </div>
                </section>
              );
            }

            return (
              <section
                key={st.id}
                onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== st.id) setDragOverStage(st.id); }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverStage((s) => (s === st.id ? null : s)); }}
                onDrop={(e) => { e.preventDefault(); onColumnDrop(st.id); }}
                className="flex flex-col rounded-[12px] border transition"
                style={{ flex: "1 1 264px", minWidth: 264, maxWidth: 352, background: "#f6f9f7", borderColor: dragOver ? "#35c77f" : "#e6ebe8", boxShadow: dragOver ? "inset 0 0 0 1px #35c77f" : undefined }}
              >
                <div className="flex flex-none items-center gap-2 border-b px-2.5 pb-[9px] pt-2.5" style={{ borderColor: "#eff3f1" }}>
                  <span className="flex h-[19px] w-[19px] flex-none items-center justify-center rounded-[6px] text-[11px] font-bold" style={{ background: "#0d3b2e", color: "#d8f5e7" }}>{i + 1}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-bold tracking-[-0.1px]">{st.title}</span>
                  <span className="ml-auto flex-none rounded-full border px-2 py-px text-[11.5px] font-[650]" style={headerCount.filt ? { background: "#e0f2e7", borderColor: "#c9e8d8", color: "#12704a" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#54655c" }}>{headerCount.text}</span>
                  <button type="button" onClick={() => toggleCol(st.id, all.length)} aria-expanded title={`Collapse ${st.title}`} className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px]" style={{ color: "#7d8c84" }}>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                  </button>
                </div>
                {st.note && <div className="-mt-[3px] px-[11px] pb-2 text-[11px]" style={{ color: "#8a9992" }}>{st.note}</div>}
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-[9px]">
                  {show.length === 0 ? (
                    <div className="rounded-[9px] border border-dashed py-4 text-center text-[11.5px]" style={{ borderColor: "#e2eae5", color: "#9aa8a1" }}>
                      {all.length ? "Nothing matches the filter" : "Nothing here yet"}
                    </div>
                  ) : group ? (
                    groupByCity(show).map(([cityCode, list]) => {
                      const key = `${st.id}|${cityCode}`;
                      const shut = !!shutGroups[key];
                      const display = cityLabel(cityCode);
                      return (
                        <div key={key} className="flex flex-col gap-[7px]">
                          <button type="button" onClick={() => toggleGroup(key)} aria-expanded={!shut} className="flex min-h-[26px] w-full items-center gap-[7px] rounded-md px-0.5 py-0.5 text-left">
                            <svg viewBox="0 0 24 24" className={`h-3 w-3 flex-none transition-transform ${shut ? "-rotate-90" : ""}`} fill="none" stroke="#9aa8a1" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                            <i className="h-2 w-2 flex-none rounded-full" style={{ background: cityHue(display) }} />
                            <span className="text-[12px] font-bold" style={{ color: "#33463e" }}>{display}</span>
                            <span className="ml-auto text-[11px] font-semibold" style={{ color: "#7d8c84" }}>{list.length}</span>
                          </button>
                          {!shut && (
                            <div className="flex flex-col gap-[7px]">
                              {list.map((c) => <Card key={c.id} card={c} inGroup owner={ownerInfo(c)} cityDisplay={cityLabel(cardCity(c))} open={openTodos(c)} done={doneTodos(c)} showTodos={showTodos} checklist={checklists[c.id] ?? []} assigneeFor={assigneeInfo} onDragStart={() => { draggingId.current = c.id; }} onClick={() => setModal({ mode: "edit", card: c })} />)}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    show.map((c) => <Card key={c.id} card={c} inGroup={false} owner={ownerInfo(c)} cityDisplay={cityLabel(cardCity(c))} open={openTodos(c)} done={doneTodos(c)} showTodos={showTodos} checklist={checklists[c.id] ?? []} assigneeFor={assigneeInfo} onDragStart={() => { draggingId.current = c.id; }} onClick={() => setModal({ mode: "edit", card: c })} />)
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {/* legend (no aging/stalled lines — aging is omitted) */}
      <div className="flex flex-none flex-wrap items-center gap-3.5 px-1 pb-2 text-[11px]" style={{ color: "#8a9992" }}>
        <span className="inline-flex items-center gap-1.5"><i className="flex h-[15px] w-[15px] items-center justify-center rounded-full border border-dashed text-[8px]" style={{ borderColor: "#b9c6bf", color: "#8a9992" }}>M</i>owner no longer linked (unmatched seed name)</span>
        <span>City colour is a scanning aid — the city name is always shown.</span>
      </div>

      {modal && (
        <KanbanCardModal boardType="field_pipeline" state={modal} api={api} existingMarkets={existingMarkets} onClose={() => setModal(null)} />
      )}

      {toast && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-lg border px-4 py-2 text-[13px] font-semibold shadow-lg" style={{ background: "#fdeae4", borderColor: "#f0bda9", color: "#a8391a" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// group cards by city code, sorted by display name
function groupByCity(cards: KanbanCard[]): [string, KanbanCard[]][] {
  const by = new Map<string, KanbanCard[]>();
  for (const c of cards) {
    const k = cardCity(c) ?? "__none__";
    (by.get(k) ?? by.set(k, []).get(k)!).push(c);
  }
  return [...by.entries()].sort((a, b) => cityLabel(a[0]).localeCompare(cityLabel(b[0])));
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[27px] items-center gap-[7px] whitespace-nowrap rounded-full border px-[11px] text-[12px] [&_b]:font-bold [&_b]:text-[#12241d]" style={{ background: "#eef3f0", borderColor: "#e2eae5", color: "#3a4d44" }}>
      {children}
    </span>
  );
}
function Sep() {
  return <span aria-hidden className="px-px text-[12px]" style={{ color: "#c3cec8" }}>·</span>;
}
function ToggleBtn({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="flex h-[34px] items-center gap-[7px] rounded-[9px] border px-3.5 text-[12.5px] font-semibold" style={on ? { background: "#e0f2e7", borderColor: "#bfe3d1", color: "#0a5c3c" } : { background: "#ffffff", borderColor: "#e2eae5", color: "#2b3d35" }}>
      {label}
    </button>
  );
}

function Card({
  card,
  inGroup,
  owner,
  cityDisplay,
  open,
  done,
  showTodos,
  checklist,
  assigneeFor,
  onDragStart,
  onClick,
}: {
  card: KanbanCard;
  inGroup: boolean;
  owner: OwnerInfo;
  cityDisplay: string;
  open: number;
  done: number;
  showTodos: boolean;
  checklist: ChecklistItem[];
  assigneeFor: (item: ChecklistItem) => { name: string; initials: string } | null;
  onDragStart: () => void;
  onClick: () => void;
}) {
  const showT = showTodos && open > 0;
  const showD = showTodos && open === 0 && done > 0;
  // Age as a proven lower bound (or exact once stage_entered_at exists). Only
  // banded cards (>= 21d) surface it; the spine and the text always agree, so
  // colour is never the only signal.
  const age = stageAge(card);
  const band = age ? ageBand(age.days) : null;
  const spineColor = band === "crit" ? "#d0512a" : band === "warn" ? "#e3c369" : "#eff3f1";
  const ageText = age && band ? `${age.exact ? "" : "≥ "}${age.days}d in stage` : null;
  return (
    // role=button + keyboard handler keep the card openable without a mouse;
    // draggable makes stage moves a pointer gesture. The card has no nested
    // interactive controls, so dragging it never conflicts with a child.
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="relative w-full cursor-grab overflow-hidden rounded-[10px] border px-2.5 py-[9px] pl-3 text-left transition hover:border-[#cfdad4] focus:outline-none focus-visible:border-[#35c77f] active:cursor-grabbing"
      style={{ background: "#ffffff", borderColor: "#e6ebe8" }}
    >
      {/* status spine — neutral, or amber/red once the card crosses a threshold */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: spineColor }} />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 break-words text-[13px] font-[650] leading-[1.3] tracking-[-0.15px]">{card.title}</div>
        {owner && (
          <span className="flex max-w-[116px] flex-none items-center gap-[5px]">
            <span
              className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[9.5px] font-bold ${owner.unlinked ? "border border-dashed" : "border"}`}
              style={owner.unlinked ? { borderColor: "#b9c6bf", background: "transparent", color: "#8a9992" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#46584f" }}
              title={owner.unlinked ? "Owner no longer linked (unmatched seed name)" : owner.name}
            >
              {owner.initials}
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px]" style={{ color: "#6d7b74" }}>
              {owner.unlinked ? `~${owner.name}` : owner.name}
            </span>
          </span>
        )}
      </div>
      {ageText && (
        <div className="mt-1.5">
          <span
            className="inline-flex items-center rounded-full border px-2 py-px text-[10.5px] font-bold"
            title={age?.exact ? "Time in current stage" : "At least this long in stage (lower bound from last update)"}
            style={band === "crit" ? { background: "#fdeae4", borderColor: "#f0bda9", color: "#a8391a" } : { background: "#fdf1d0", borderColor: "#e3c369", color: "#8a6300" }}
          >
            {ageText}
          </span>
        </div>
      )}
      {!inGroup && (
        <div className="mt-1.5 flex flex-wrap items-center gap-[7px]">
          <span className="inline-flex items-center gap-[5px] rounded-full border px-2 py-px pl-1.5 text-[11px]" style={{ background: "#eef3f0", borderColor: "#e2eae5", color: "#54655c" }}>
            <i className="h-2 w-2 rounded-full" style={{ background: cityHue(cityDisplay) }} />
            {cityDisplay}
          </span>
        </div>
      )}
      {showT && (
        <div className="mt-2 flex flex-col gap-[5px] border-t pt-[7px]" style={{ borderColor: "#eff3f1" }}>
          {checklist.filter((i) => !i.done).map((i) => {
            // Assignee sits to the right of the to-do text: same avatar-initial +
            // name treatment as the card owner, one step smaller and quieter so
            // the owner still reads as the card's primary person. The to-do TEXT
            // truncates (with a title) when tight; the assignee name never does.
            const a = assigneeFor(i);
            return (
              <div key={i.id} className="flex items-center gap-[7px] text-[11.5px] leading-[1.35]" style={{ color: "#3a4d44" }}>
                <span className="h-[13px] w-[13px] flex-none rounded border-[1.5px]" style={{ borderColor: "#b9c6bf", background: "#fff" }} />
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={i.text}>{i.text}</span>
                {a ? (
                  <span className="flex flex-none items-center gap-[4px]" title={a.name}>
                    <span className="flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full border text-[8px] font-bold" style={{ background: "#eef3f0", borderColor: "#e2eae5", color: "#46584f" }}>{a.initials}</span>
                    <span className="whitespace-nowrap text-[10.5px]" style={{ color: "#626f68" }}>{a.name}</span>
                  </span>
                ) : (
                  <span className="flex-none text-[10.5px] italic" style={{ color: "#626f68" }}>Unassigned</span>
                )}
              </div>
            );
          })}
          {done > 0 && <div className="text-[11px]" style={{ color: "#8a9992" }}>{done} done</div>}
        </div>
      )}
      {showD && (
        <div className="mt-[7px] flex items-center gap-1.5 text-[11px]" style={{ color: "#12704a" }}>
          <svg viewBox="0 0 24 24" className="h-[11px] w-[11px]" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          all {done} to-{done > 1 ? "dos" : "do"} done
        </div>
      )}
    </div>
  );
}
