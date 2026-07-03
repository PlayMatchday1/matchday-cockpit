"use client";

// Data layer for a single kanban board. Reads/writes go straight to
// Supabase from the client (same pattern as Goals/Topics); RLS gates
// them to authenticated users, and a DB trigger writes the audit log,
// so there is no server route to maintain. Reloads on mount and on
// window focus (pull-on-focus is enough — realtime is optional).

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  BOARD_CONFIG,
  type BoardType,
  type ChecklistItem,
  type KanbanCard,
  type KanbanOwner,
} from "@/lib/kanban";

export type CardPatch = Partial<
  Pick<KanbanCard, "title" | "stage" | "owner_user_id" | "sort_order" | "data">
>;

export type NewCardInput = {
  title: string;
  stage: string;
  owner_user_id: string | null;
  data: Record<string, unknown>;
};

export type KanbanApi = {
  cards: KanbanCard[];
  checklists: Record<string, ChecklistItem[]>;
  owners: KanbanOwner[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createCard: (input: NewCardInput) => Promise<string | null>;
  updateCard: (id: string, patch: CardPatch) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  setOwner: (id: string, ownerId: string | null) => Promise<void>;
  addChecklistItem: (
    cardId: string,
    text: string,
    ownerId: string | null,
  ) => Promise<void>;
  updateChecklistItem: (
    id: string,
    patch: Partial<Pick<ChecklistItem, "text" | "done" | "owner_user_id">>,
  ) => Promise<void>;
  removeChecklistItem: (id: string) => Promise<void>;
};

export function useKanbanBoard(boardType: BoardType): KanbanApi {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [checklists, setChecklists] = useState<
    Record<string, ChecklistItem[]>
  >({});
  const [owners, setOwners] = useState<KanbanOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const showChecklists = BOARD_CONFIG[boardType].showChecklists;

  const reload = useCallback(async () => {
    setError(null);
    try {
      const cardsRes = await supabase
        .from("kanban_cards")
        .select("*")
        .eq("board_type", boardType)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (cardsRes.error) throw cardsRes.error;
      const loadedCards = (cardsRes.data ?? []) as KanbanCard[];
      setCards(loadedCards);

      if (showChecklists && loadedCards.length > 0) {
        const clRes = await supabase
          .from("kanban_checklist_items")
          .select("*")
          .in(
            "card_id",
            loadedCards.map((c) => c.id),
          )
          .order("sort_order", { ascending: true });
        if (clRes.error) throw clRes.error;
        const grouped: Record<string, ChecklistItem[]> = {};
        for (const it of (clRes.data ?? []) as ChecklistItem[]) {
          (grouped[it.card_id] ??= []).push(it);
        }
        setChecklists(grouped);
      } else {
        setChecklists({});
      }

      const ownersRes = await supabase
        .from("app_users")
        .select("id, email, full_name")
        .eq("is_admin", true)
        .order("full_name", { ascending: true, nullsFirst: false });
      if (!ownersRes.error) {
        setOwners((ownersRes.data ?? []) as KanbanOwner[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [boardType, showChecklists]);

  // Load on mount + refresh when the window regains focus.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    void reload();
    const onFocus = () => void reloadRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const createCard = useCallback(
    async (input: NewCardInput): Promise<string | null> => {
      // Place new cards at the end of their column.
      const maxOrder = cards
        .filter((c) => c.stage === input.stage)
        .reduce((m, c) => Math.max(m, c.sort_order), 0);
      const ins = await supabase
        .from("kanban_cards")
        .insert({
          board_type: boardType,
          title: input.title,
          stage: input.stage,
          owner_user_id: input.owner_user_id,
          sort_order: maxOrder + 1,
          data: input.data,
        })
        .select("*")
        .single();
      if (ins.error || !ins.data) {
        setError(ins.error?.message ?? "Create failed");
        void reload();
        return null;
      }
      setCards((prev) => [...prev, ins.data as KanbanCard]);
      return (ins.data as KanbanCard).id;
    },
    [boardType, cards, reload],
  );

  const updateCard = useCallback(
    async (id: string, patch: CardPatch): Promise<void> => {
      setCards((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
      const upd = await supabase.from("kanban_cards").update(patch).eq("id", id);
      if (upd.error) {
        setError(upd.error.message);
        void reload();
      }
    },
    [reload],
  );

  const deleteCard = useCallback(
    async (id: string): Promise<void> => {
      setCards((prev) => prev.filter((c) => c.id !== id));
      setChecklists((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      const del = await supabase.from("kanban_cards").delete().eq("id", id);
      if (del.error) {
        setError(del.error.message);
        void reload();
      }
    },
    [reload],
  );

  const setOwner = useCallback(
    async (id: string, ownerId: string | null): Promise<void> => {
      const card = cards.find((c) => c.id === id);
      const data = { ...(card?.data ?? {}) };
      // Once a real owner is linked, drop the seed owner-label fallback.
      if (ownerId) delete data.owner_label;
      await updateCard(id, { owner_user_id: ownerId, data });
    },
    [cards, updateCard],
  );

  const addChecklistItem = useCallback(
    async (
      cardId: string,
      text: string,
      ownerId: string | null,
    ): Promise<void> => {
      const items = checklists[cardId] ?? [];
      const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order), 0);
      const ins = await supabase
        .from("kanban_checklist_items")
        .insert({
          card_id: cardId,
          text,
          done: false,
          owner_user_id: ownerId,
          sort_order: maxOrder + 1,
        })
        .select("*")
        .single();
      if (ins.error || !ins.data) {
        setError(ins.error?.message ?? "Checklist add failed");
        void reload();
        return;
      }
      setChecklists((prev) => ({
        ...prev,
        [cardId]: [...(prev[cardId] ?? []), ins.data as ChecklistItem],
      }));
    },
    [checklists, reload],
  );

  const updateChecklistItem = useCallback(
    async (
      id: string,
      patch: Partial<Pick<ChecklistItem, "text" | "done" | "owner_user_id">>,
    ): Promise<void> => {
      setChecklists((prev) => {
        const next: Record<string, ChecklistItem[]> = {};
        for (const [cid, items] of Object.entries(prev)) {
          next[cid] = items.map((i) => (i.id === id ? { ...i, ...patch } : i));
        }
        return next;
      });
      const upd = await supabase
        .from("kanban_checklist_items")
        .update(patch)
        .eq("id", id);
      if (upd.error) {
        setError(upd.error.message);
        void reload();
      }
    },
    [reload],
  );

  const removeChecklistItem = useCallback(
    async (id: string): Promise<void> => {
      setChecklists((prev) => {
        const next: Record<string, ChecklistItem[]> = {};
        for (const [cid, items] of Object.entries(prev)) {
          next[cid] = items.filter((i) => i.id !== id);
        }
        return next;
      });
      const del = await supabase
        .from("kanban_checklist_items")
        .delete()
        .eq("id", id);
      if (del.error) {
        setError(del.error.message);
        void reload();
      }
    },
    [reload],
  );

  return {
    cards,
    checklists,
    owners,
    loading,
    error,
    reload,
    createCard,
    updateCard,
    deleteCard,
    setOwner,
    addChecklistItem,
    updateChecklistItem,
    removeChecklistItem,
  };
}
