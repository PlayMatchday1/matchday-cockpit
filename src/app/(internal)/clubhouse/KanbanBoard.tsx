"use client";

// Shared kanban engine. One component powers both Clubhouse boards
// (Field Pipeline + Tech Roadmap) off a per-board config. Native
// HTML5 drag/drop moves cards between columns and reorders within a
// column; Field Pipeline's Confirmed + Archived columns render as
// collapsible per-city groups. Cream / dark-green palette throughout.

import { useMemo, useRef, useState } from "react";
import {
  BOARD_CONFIG,
  cardCity,
  cardOwnerLabel,
  cardPlannedDate,
  cardPriority,
  cityColor,
  cityLabel,
  firstName,
  isKnownCity,
  ownerName,
  type BoardType,
  type ChecklistItem,
  type KanbanCard,
  type KanbanOwner,
  type StageDef,
} from "@/lib/kanban";
import { useKanbanBoard, type KanbanApi } from "@/lib/useKanbanBoard";
import KanbanCardModal, { type ModalState } from "./KanbanCardModal";

const PRIORITY_CLASS: Record<string, string> = {
  High: "bg-coral-soft text-coral-hover",
  Medium: "bg-gold-soft text-deep-green/70",
  Low: "bg-cream-soft text-deep-green/55",
};

export default function KanbanBoard({ boardType }: { boardType: BoardType }) {
  const config = BOARD_CONFIG[boardType];
  const api = useKanbanBoard(boardType);
  const { cards, checklists, owners, loading, error } = api;

  const [modal, setModal] = useState<ModalState | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string>("all"); // "all" | "unassigned" | ownerId
  const [search, setSearch] = useState("");
  const [showTodos, setShowTodos] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const draggingId = useRef<string | null>(null);

  const ownersById = useMemo(
    () => new Map(owners.map((o) => [o.id, o])),
    [owners],
  );

  const existingMarkets = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) {
      const city = cardCity(c);
      if (city && !isKnownCity(city)) set.add(city);
    }
    return [...set].sort();
  }, [cards]);

  const matchesFilters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (c: KanbanCard): boolean => {
      if (ownerFilter === "unassigned" && c.owner_user_id !== null) return false;
      if (
        ownerFilter !== "all" &&
        ownerFilter !== "unassigned" &&
        c.owner_user_id !== ownerFilter
      )
        return false;
      if (!q) return true;
      const owner = c.owner_user_id ? ownersById.get(c.owner_user_id) : null;
      const hay = [
        c.title,
        cityLabel(cardCity(c)),
        owner ? ownerName(owner) : cardOwnerLabel(c),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };
  }, [ownerFilter, search, ownersById]);

  const visibleCards = useMemo(
    () => cards.filter(matchesFilters),
    [cards, matchesFilters],
  );

  function cardsInStage(stageId: string): KanbanCard[] {
    return visibleCards
      .filter((c) => c.stage === stageId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  // Drop resolution. beforeId = insert ahead of that card (flat
  // columns only); null = append to the end of the stage.
  async function drop(stageId: string, grouped: boolean, beforeId: string | null) {
    const id = draggingId.current;
    draggingId.current = null;
    setDragOverStage(null);
    if (!id) return;
    const moving = cards.find((c) => c.id === id);
    if (!moving) return;

    const siblings = cards
      .filter((c) => c.stage === stageId && c.id !== id)
      .sort((a, b) => a.sort_order - b.sort_order);

    let newOrder: number;
    if (grouped || !beforeId) {
      newOrder = siblings.reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
    } else {
      const idx = siblings.findIndex((c) => c.id === beforeId);
      if (idx === -1) {
        newOrder =
          siblings.reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
      } else {
        const before = siblings[idx];
        const prev = siblings[idx - 1];
        newOrder = prev
          ? (prev.sort_order + before.sort_order) / 2
          : before.sort_order - 1;
      }
    }
    if (moving.stage === stageId && moving.sort_order === newOrder) return;
    await api.updateCard(id, { stage: stageId, sort_order: newOrder });
  }

  // Field Pipeline summary (replicates the prototype's stat row).
  const summary = useMemo(() => {
    if (boardType !== "field_pipeline") return null;
    const cityset = new Set<string>();
    for (const c of cards) {
      const city = cardCity(c);
      if (city) cityset.add(city);
    }
    let openTodos = 0;
    for (const items of Object.values(checklists)) {
      openTodos += items.filter((i) => !i.done).length;
    }
    return {
      cities: cityset.size,
      fields: cards.length,
      confirmed: cards.filter((c) => c.stage === "confirmed").length,
      openTodos,
    };
  }, [boardType, cards, checklists]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="w-1 self-stretch rounded-full bg-mint" />
          <div>
            <h2 className="text-xl font-bold tracking-tight text-deep-green">
              {config.title}
            </h2>
            <p className="text-sm text-deep-green/55">{config.subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {config.showChecklists && (
            <button
              type="button"
              onClick={() => setShowTodos((v) => !v)}
              className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green/70 transition hover:bg-cream-soft"
            >
              {showTodos ? "Hide to-dos" : "Show to-dos"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setModal({ mode: "create" })}
            className="rounded-full bg-deep-green px-4 py-1.5 text-sm font-bold text-cream transition hover:bg-deep-green-soft"
          >
            + New card
          </button>
        </div>
      </div>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryCard label="Cities" value={summary.cities} />
          <SummaryCard label="Fields" value={summary.fields} />
          <SummaryCard label="Confirmed" value={summary.confirmed} />
          <SummaryCard label="Open to-dos" value={summary.openTodos} />
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_220px]">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            config.showChecklists
              ? "Search field, city, or owner…"
              : "Search by title…"
          }
          className="h-10 rounded-lg border border-cream-line bg-white px-3 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
        />
        <select
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          className="h-10 rounded-lg border border-cream-line bg-white px-3 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
        >
          <option value="all">All owners</option>
          <option value="unassigned">Unassigned</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {ownerName(o)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
          {error}
        </div>
      )}
      {loading && cards.length === 0 && (
        <div className="py-10 text-center text-sm text-deep-green/45">
          Loading board…
        </div>
      )}

      {/* Board */}
      <div className="overflow-x-auto pb-3">
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${config.stages.length}, minmax(${config.minColWidthPx}px, 1fr))`,
            minWidth: config.stages.length * (config.minColWidthPx + 12),
          }}
        >
          {config.stages.map((stage, i) => (
            <Column
              key={stage.id}
              stage={stage}
              index={i}
              cards={cardsInStage(stage.id)}
              checklists={checklists}
              ownersById={ownersById}
              showTodos={showTodos}
              showCity={config.showCity}
              dragOver={dragOverStage === stage.id}
              onDragEnterStage={() => setDragOverStage(stage.id)}
              onDragLeaveStage={() => setDragOverStage(null)}
              onDropCard={(beforeId) =>
                void drop(stage.id, !!stage.grouped, beforeId)
              }
              onDragStartCard={(id) => (draggingId.current = id)}
              expanded={expanded}
              setExpanded={setExpanded}
              onEditCard={(card) => setModal({ mode: "edit", card })}
              onSetOwner={(id, ownerId) => void api.setOwner(id, ownerId)}
              owners={owners}
              onToggleTodo={(itemId, done) =>
                void api.updateChecklistItem(itemId, { done })
              }
            />
          ))}
        </div>
      </div>

      {modal && (
        <KanbanCardModal
          boardType={boardType}
          state={modal}
          api={api}
          existingMarkets={existingMarkets}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-cream-line bg-white px-3 py-2 shadow-sm shadow-deep-green/5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-deep-green/50">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-bold text-deep-green">{value}</div>
    </div>
  );
}

function Column({
  stage,
  index,
  cards,
  checklists,
  ownersById,
  showTodos,
  showCity,
  dragOver,
  onDragEnterStage,
  onDragLeaveStage,
  onDropCard,
  onDragStartCard,
  expanded,
  setExpanded,
  onEditCard,
  onSetOwner,
  owners,
  onToggleTodo,
}: {
  stage: StageDef;
  index: number;
  cards: KanbanCard[];
  checklists: Record<string, ChecklistItem[]>;
  ownersById: Map<string, KanbanOwner>;
  showTodos: boolean;
  showCity: boolean;
  dragOver: boolean;
  onDragEnterStage: () => void;
  onDragLeaveStage: () => void;
  onDropCard: (beforeId: string | null) => void;
  onDragStartCard: (id: string) => void;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onEditCard: (card: KanbanCard) => void;
  onSetOwner: (id: string, ownerId: string | null) => void;
  owners: KanbanOwner[];
  onToggleTodo: (itemId: string, done: boolean) => void;
}) {
  const grouped = !!stage.grouped;

  const cityGroups = useMemo(() => {
    if (!grouped) return [];
    const byCity = new Map<string, KanbanCard[]>();
    for (const c of cards) {
      const city = cardCity(c) ?? "No city";
      (byCity.get(city) ?? byCity.set(city, []).get(city)!).push(c);
    }
    return [...byCity.entries()]
      .map(([city, list]) => ({
        city,
        cards: list.sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => cityLabel(a.city).localeCompare(cityLabel(b.city)));
  }, [grouped, cards]);

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        onDragEnterStage();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) onDragLeaveStage();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropCard(null);
      }}
      className={`flex min-h-[520px] flex-col rounded-2xl border p-2.5 transition ${
        dragOver
          ? "border-deep-green/40 bg-cream-soft"
          : "border-cream-line bg-cream-soft/40"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 border-b border-cream-line px-1 pb-2">
        <div className="flex items-center gap-2">
          <span className="inline-grid h-6 w-6 place-items-center rounded-full bg-deep-green text-[11px] font-bold text-cream">
            {index + 1}
          </span>
          <span className="text-sm font-bold text-deep-green">
            {stage.title}
          </span>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-deep-green/70">
          {cards.length}
        </span>
      </div>
      {stage.note && (
        <p className="mb-2 px-1 text-[11px] font-medium text-deep-green/50">
          {stage.note}
        </p>
      )}

      <div className="flex flex-1 flex-col gap-2">
        {grouped
          ? cityGroups.map((g) => {
              const key = `${stage.id}::${g.city}`;
              // Default to EXPANDED so every card (and its to-do box) is
              // visible without a click. This is a shared team tool, not
              // George's single-user prototype where collapsed-by-default
              // was fine — hiding cards by default hurts visibility and
              // defeats the "Open to-dos" summary counter. Users can still
              // collapse a city; that explicit choice is recorded in
              // `expanded` and wins over this default.
              const open = expanded[key] ?? true;
              return (
                <section
                  key={key}
                  onDragOver={(e) => {
                    e.preventDefault();
                    onDragEnterStage();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDropCard(null);
                  }}
                  className="overflow-hidden rounded-xl border border-cream-line bg-white"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [key]: !open }))
                    }
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition hover:bg-cream-soft"
                  >
                    <span className="flex items-center gap-2 text-sm font-bold text-deep-green">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: cityColor(g.city) }}
                      />
                      {cityLabel(g.city)}
                    </span>
                    <span className="text-[11px] font-bold text-deep-green/50">
                      {g.cards.length} {open ? "▴" : "▾"}
                    </span>
                  </button>
                  {open && (
                    <div className="grid gap-2 border-t border-cream-line p-2">
                      {g.cards.map((c) => (
                        <Card
                          key={c.id}
                          card={c}
                          items={checklists[c.id] ?? []}
                          ownersById={ownersById}
                          owners={owners}
                          showTodos={showTodos}
                          showCity={showCity}
                          onDragStart={() => onDragStartCard(c.id)}
                          onDropBefore={() => onDropCard(null)}
                          onEdit={() => onEditCard(c)}
                          onSetOwner={onSetOwner}
                          onToggleTodo={onToggleTodo}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })
          : cards.map((c) => (
              <Card
                key={c.id}
                card={c}
                items={checklists[c.id] ?? []}
                ownersById={ownersById}
                owners={owners}
                showTodos={showTodos}
                showCity={showCity}
                onDragStart={() => onDragStartCard(c.id)}
                onDropBefore={() => onDropCard(c.id)}
                onEdit={() => onEditCard(c)}
                onSetOwner={onSetOwner}
                onToggleTodo={onToggleTodo}
              />
            ))}
      </div>
    </section>
  );
}

function Card({
  card,
  items,
  ownersById,
  owners,
  showTodos,
  showCity,
  onDragStart,
  onDropBefore,
  onEdit,
  onSetOwner,
  onToggleTodo,
}: {
  card: KanbanCard;
  items: ChecklistItem[];
  ownersById: Map<string, KanbanOwner>;
  owners: KanbanOwner[];
  showTodos: boolean;
  showCity: boolean;
  onDragStart: () => void;
  onDropBefore: () => void;
  onEdit: () => void;
  onSetOwner: (id: string, ownerId: string | null) => void;
  onToggleTodo: (itemId: string, done: boolean) => void;
}) {
  const city = cardCity(card);
  const priority = cardPriority(card);
  const planned = cardPlannedDate(card);
  const doneCount = items.filter((i) => i.done).length;

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropBefore();
      }}
      onClick={onEdit}
      className="group cursor-pointer overflow-hidden rounded-xl border border-cream-line bg-white shadow-sm shadow-deep-green/5 transition hover:shadow-md hover:shadow-deep-green/10"
    >
      {showCity && (
        <div
          aria-hidden
          className="h-1.5 w-full"
          style={{ background: cityColor(city) }}
        />
      )}
      <div className="p-2.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-bold leading-tight text-deep-green">
            {card.title}
          </h3>
          <OwnerBubble
            card={card}
            ownersById={ownersById}
            owners={owners}
            onSetOwner={onSetOwner}
          />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {showCity && city && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{
                backgroundColor: cityColor(city) + "1a",
                color: cityColor(city),
              }}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: cityColor(city) }}
              />
              {cityLabel(city)}
            </span>
          )}
          {priority && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                PRIORITY_CLASS[priority] ?? "bg-cream-soft text-deep-green/55"
              }`}
            >
              {priority}
            </span>
          )}
          {planned && (
            <span className="rounded-full bg-cream-soft px-2 py-0.5 text-[11px] font-bold text-deep-green/55">
              {planned}
            </span>
          )}
        </div>

        {showTodos && items.length > 0 && (
          <div className="mt-2 rounded-lg border border-cream-line bg-cream-soft/60 p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-deep-green/55">
              <span>To-dos</span>
              <span>
                {doneCount}/{items.length}
              </span>
            </div>
            <ul className="grid gap-1">
              {items.map((it) => {
                const o = it.owner_user_id
                  ? ownersById.get(it.owner_user_id)
                  : null;
                return (
                  <li
                    key={it.id}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5 text-xs font-medium"
                  >
                    <input
                      type="checkbox"
                      checked={it.done}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onToggleTodo(it.id, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-deep-green/30 accent-deep-green"
                    />
                    <span
                      className={
                        it.done
                          ? "text-deep-green/40 line-through"
                          : "text-deep-green/80"
                      }
                    >
                      {it.text}
                    </span>
                    {o && (
                      <span className="rounded-full border border-cream-line bg-white px-1.5 py-0.5 text-[9px] font-bold text-deep-green/60">
                        {firstName(ownerName(o))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

function OwnerBubble({
  card,
  ownersById,
  owners,
  onSetOwner,
}: {
  card: KanbanCard;
  ownersById: Map<string, KanbanOwner>;
  owners: KanbanOwner[];
  onSetOwner: (id: string, ownerId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const linked = card.owner_user_id ? ownersById.get(card.owner_user_id) : null;
  const label = cardOwnerLabel(card);

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={card.owner_user_id ?? ""}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          onSetOwner(card.id, e.target.value || null);
          setEditing(false);
        }}
        onBlur={() => setEditing(false)}
        className="h-7 w-24 shrink-0 rounded-full border border-cream-line bg-white px-2 text-[11px] font-bold text-deep-green focus:outline-none"
      >
        <option value="">Unassigned</option>
        {owners.map((o) => (
          <option key={o.id} value={o.id}>
            {ownerName(o)}
          </option>
        ))}
      </select>
    );
  }

  // Linked owner → solid chip. Unlinked seed label → dashed "unlinked"
  // chip so it's visibly distinct from a real app-user owner.
  const isUnlinkedLabel = !linked && !!label;
  return (
    <button
      type="button"
      title={
        isUnlinkedLabel
          ? "Owner not linked to an app user — click to assign"
          : "Click to change owner"
      }
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
        linked
          ? "bg-cream-soft text-deep-green hover:bg-cream-line"
          : isUnlinkedLabel
            ? "border border-dashed border-deep-green/40 bg-transparent text-deep-green/60 hover:bg-cream-soft"
            : "border border-cream-line bg-transparent text-deep-green/40 hover:bg-cream-soft"
      }`}
    >
      {linked ? firstName(ownerName(linked)) : isUnlinkedLabel ? `~${label}` : "Assign"}
    </button>
  );
}
