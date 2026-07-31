"use client";

// Add / edit / delete modal shared by both kanban boards. Field set
// branches on board_type: Field Pipeline shows city + a per-card
// checklist; Tech Roadmap shows description + priority + planned date.
// Both share title, owner, stage, and delete.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  BOARD_CONFIG,
  FIELD_CITY_CODES,
  NEW_MARKET_SENTINEL,
  PRIORITIES,
  cardCity,
  cardDescription,
  cardEstimatedHours,
  parseEstimatedHours,
  cardOwnerLabel,
  cardPlannedDate,
  cardPriority,
  cityLabel,
  isKnownCity,
  ownerName,
  type BoardType,
  type KanbanCard,
  type Priority,
} from "@/lib/kanban";
import type { KanbanApi } from "@/lib/useKanbanBoard";

export type ModalState =
  | { mode: "create" }
  | { mode: "edit"; card: KanbanCard };

type LocalTodo = {
  id?: string; // present = existing row
  text: string;
  done: boolean;
  owner_user_id: string | null;
};

const inputCls =
  "h-11 w-full rounded-lg border border-cream-line bg-white px-3 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none";
const labelCls =
  "grid gap-1.5 text-[11px] font-bold uppercase tracking-wide text-deep-green/60";

export default function KanbanCardModal({
  boardType,
  state,
  api,
  existingMarkets,
  onClose,
}: {
  boardType: BoardType;
  state: ModalState;
  api: KanbanApi;
  existingMarkets: string[];
  onClose: () => void;
}) {
  const config = BOARD_CONFIG[boardType];
  const editing = state.mode === "edit" ? state.card : null;

  const [title, setTitle] = useState(editing?.title ?? "");
  const [stage, setStage] = useState(
    editing?.stage ?? config.stages[0].id,
  );
  const [ownerId, setOwnerId] = useState<string | null>(
    editing?.owner_user_id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Field Pipeline. An existing city (known code or exploration
  // market) is already an option below, so the select can bind to it
  // directly; the sentinel is only for naming a brand-new market.
  const initialCity = editing ? cardCity(editing) : null;
  const [citySelect, setCitySelect] = useState<string>(
    initialCity ?? FIELD_CITY_CODES[0],
  );
  const [newMarket, setNewMarket] = useState<string>("");
  const [todos, setTodos] = useState<LocalTodo[]>(() =>
    editing
      ? (api.checklists[editing.id] ?? []).map((i) => ({
          id: i.id,
          text: i.text,
          done: i.done,
          owner_user_id: i.owner_user_id,
        }))
      : [],
  );
  const [newTodo, setNewTodo] = useState("");

  // Tech Roadmap
  const [description, setDescription] = useState(
    editing ? cardDescription(editing) : "",
  );
  const [priority, setPriority] = useState<Priority>(
    (editing && cardPriority(editing)) || "Medium",
  );
  const [plannedDate, setPlannedDate] = useState(
    editing ? cardPlannedDate(editing) : "",
  );
  const [estimatedHours, setEstimatedHours] = useState(
    editing ? (cardEstimatedHours(editing)?.toString() ?? "") : "",
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const cityOptions = useMemo(() => {
    const markets = existingMarkets.filter((m) => !isKnownCity(m));
    return { codes: FIELD_CITY_CODES, markets };
  }, [existingMarkets]);

  const resolvedCity = (): string => {
    if (citySelect === NEW_MARKET_SENTINEL) return newMarket.trim();
    return citySelect;
  };

  async function syncChecklist(cardId: string) {
    const existing = api.checklists[cardId] ?? [];
    const localById = new Map(
      todos.filter((t) => t.id).map((t) => [t.id!, t]),
    );
    // Removals
    for (const ex of existing) {
      if (!localById.has(ex.id)) await api.removeChecklistItem(ex.id);
    }
    // Updates
    for (const ex of existing) {
      const local = localById.get(ex.id);
      if (!local) continue;
      if (
        local.text !== ex.text ||
        local.done !== ex.done ||
        local.owner_user_id !== ex.owner_user_id
      ) {
        await api.updateChecklistItem(ex.id, {
          text: local.text,
          done: local.done,
          owner_user_id: local.owner_user_id,
        });
      }
    }
    // Additions
    for (const t of todos) {
      if (!t.id && t.text.trim()) {
        await api.addChecklistItem(cardId, t.text.trim(), t.owner_user_id);
      }
    }
  }

  async function handleSave() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      let data: Record<string, unknown>;
      if (boardType === "field_pipeline") {
        data = { city: resolvedCity() || null };
        // Preserve the seed owner-label only while the card stays
        // unassigned; a real owner supersedes it.
        const label = editing ? cardOwnerLabel(editing) : "";
        if (!ownerId && label) data.owner_label = label;
      } else {
        data = {
          description: description.trim(),
          priority,
          planned_date: plannedDate || null,
          estimated_hours: parseEstimatedHours(estimatedHours),
        };
      }

      if (editing) {
        await api.updateCard(editing.id, {
          title: trimmed,
          stage,
          owner_user_id: ownerId,
          data,
        });
        if (config.showChecklists) await syncChecklist(editing.id);
      } else {
        const id = await api.createCard({
          title: trimmed,
          stage,
          owner_user_id: ownerId,
          data,
        });
        if (id && config.showChecklists) await syncChecklist(id);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.deleteCard(editing.id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-deep-green/40 px-4 py-10 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl border border-cream-line bg-cream p-6 shadow-2xl shadow-deep-green/30"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-deep-green">
              {editing ? "Edit card" : "New card"}
            </h2>
            <p className="mt-0.5 text-xs text-deep-green/55">{config.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3">
          <label className={labelCls}>
            Title
            <input
              className={inputCls}
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                boardType === "field_pipeline"
                  ? "e.g. Centennial Commons"
                  : "e.g. Bulk close in Chats"
              }
            />
          </label>

          {boardType === "tech_roadmap" && (
            <label className={labelCls}>
              Description
              <textarea
                className="min-h-[84px] w-full rounded-lg border border-cream-line bg-white px-3 py-2 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional details"
              />
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            {boardType === "field_pipeline" && (
              <label className={labelCls}>
                City
                <select
                  className={inputCls}
                  value={citySelect}
                  onChange={(e) => setCitySelect(e.target.value)}
                >
                  {cityOptions.codes.map((c) => (
                    <option key={c} value={c}>
                      {cityLabel(c)}
                    </option>
                  ))}
                  {cityOptions.markets.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={NEW_MARKET_SENTINEL}>New Market…</option>
                </select>
              </label>
            )}

            {boardType === "tech_roadmap" && (
              <label className={labelCls}>
                Planned date
                <input
                  type="date"
                  className={inputCls}
                  value={plannedDate}
                  onChange={(e) => setPlannedDate(e.target.value)}
                />
              </label>
            )}

            <label className={labelCls}>
              Owner
              <select
                className={inputCls}
                value={ownerId ?? ""}
                onChange={(e) => setOwnerId(e.target.value || null)}
              >
                <option value="">Unassigned</option>
                {api.owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {ownerName(o)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {boardType === "tech_roadmap" && (
            <label className={labelCls}>
              Estimated hours
              <input
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                className={inputCls}
                value={estimatedHours}
                onChange={(e) => setEstimatedHours(e.target.value)}
                placeholder="e.g. 1.5"
              />
            </label>
          )}

          {citySelect === NEW_MARKET_SENTINEL &&
            boardType === "field_pipeline" && (
              <label className={labelCls}>
                New market name
                <input
                  className={inputCls}
                  value={newMarket}
                  onChange={(e) => setNewMarket(e.target.value)}
                  placeholder="e.g. Philadelphia"
                />
              </label>
            )}

          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Stage
              <select
                className={inputCls}
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                {config.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>

            {boardType === "tech_roadmap" && (
              <div className={labelCls}>
                Priority
                <div className="flex h-11 items-center gap-1.5">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                        priority === p
                          ? "bg-deep-green text-cream"
                          : "border border-cream-line bg-white text-deep-green/60 hover:bg-cream-soft"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {config.showChecklists && (
            <ChecklistEditor
              todos={todos}
              setTodos={setTodos}
              newTodo={newTodo}
              setNewTodo={setNewTodo}
              owners={api.owners}
            />
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {editing &&
              (confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-deep-green/70">
                    Delete this card?
                  </span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={busy}
                    className="rounded-full bg-coral px-3 py-1.5 text-xs font-bold text-white transition hover:bg-coral-hover disabled:opacity-50"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                    className="rounded-full px-2 py-1.5 text-xs font-medium text-deep-green/60 hover:text-deep-green"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className="rounded-full border border-coral/40 px-3 py-1.5 text-xs font-bold text-coral transition hover:bg-coral-soft disabled:opacity-50"
                >
                  Delete
                </button>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full border border-cream-line bg-transparent px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || !title.trim()}
              className="rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-cream transition hover:bg-deep-green-soft disabled:opacity-50"
            >
              {editing ? "Save changes" : "Add card"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChecklistEditor({
  todos,
  setTodos,
  newTodo,
  setNewTodo,
  owners,
}: {
  todos: LocalTodo[];
  setTodos: React.Dispatch<React.SetStateAction<LocalTodo[]>>;
  newTodo: string;
  setNewTodo: (v: string) => void;
  owners: { id: string; email: string; full_name: string | null }[];
}) {
  function add() {
    const t = newTodo.trim();
    if (!t) return;
    setTodos((prev) => [
      ...prev,
      { text: t, done: false, owner_user_id: null },
    ]);
    setNewTodo("");
  }
  return (
    <div className="rounded-xl border border-cream-line bg-cream-soft/50 p-3">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-deep-green/60">
        To-dos
      </div>
      <div className="grid gap-2">
        {todos.length === 0 && (
          <div className="text-xs font-medium text-deep-green/45">
            No to-dos yet.
          </div>
        )}
        {todos.map((t, i) => (
          <div
            key={t.id ?? `new-${i}`}
            className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2"
          >
            <input
              type="checkbox"
              checked={t.done}
              onChange={(e) =>
                setTodos((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, done: e.target.checked } : x,
                  ),
                )
              }
              className="h-4 w-4 rounded border-deep-green/30 accent-deep-green"
            />
            <input
              className="h-9 w-full rounded-lg border border-cream-line bg-white px-2 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
              value={t.text}
              onChange={(e) =>
                setTodos((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, text: e.target.value } : x,
                  ),
                )
              }
            />
            <select
              className="h-9 w-28 rounded-lg border border-cream-line bg-white px-1.5 text-xs font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
              value={t.owner_user_id ?? ""}
              onChange={(e) =>
                setTodos((prev) =>
                  prev.map((x, j) =>
                    j === i
                      ? { ...x, owner_user_id: e.target.value || null }
                      : x,
                  ),
                )
              }
            >
              <option value="">No owner</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {ownerName(o)}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Remove to-do"
              onClick={() =>
                setTodos((prev) => prev.filter((_, j) => j !== i))
              }
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-cream-line bg-white text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
        <input
          className="h-9 w-full rounded-lg border border-cream-line bg-white px-2 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add to-do…"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg border border-cream-line bg-white px-3 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
        >
          Add
        </button>
      </div>
    </div>
  );
}
