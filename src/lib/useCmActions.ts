"use client";

/* Data layer for the meeting action items. Reads and writes go straight to Supabase from the
 * client, same pattern as the kanban boards: RLS gates them to authenticated users, so there is no
 * server route to maintain. Clubhouse-only tables — nothing here touches mdapi_* or the Google
 * Sheet the check-ins come from. */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { buildInsert, nextOrder, stepOrder, type CmItem, type CmStatus, type CmUpdate, type NewItem } from "./cmActions";

export type CmApi = {
  items: CmItem[];
  updates: CmUpdate[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setStatus: (id: string, status: CmStatus) => Promise<void>;
  addUpdate: (itemId: string, body: string, author: string | null, reportedOn?: string) => Promise<void>;
  carryForward: (fromMonth: string, toMonth: string) => Promise<number>;
  addItem: (input: NewItem) => Promise<void>;
  updateItem: (id: string, patch: { body?: string; owner?: string | null; source?: string }) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  /** Move a row one place within the list it is rendered in. Writes ONE row. */
  reorder: (siblings: readonly CmItem[], id: string, delta: -1 | 1) => Promise<void>;
};

export function useCmActions(month: string): CmApi {
  const [items, setItems] = useState<CmItem[]>([]);
  const [updates, setUpdates] = useState<CmUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await supabase.from("cm_action_items").select("*").eq("month", month)
        .order("sort_order", { ascending: true });
      if (res.error) throw res.error;
      const loaded = (res.data ?? []) as CmItem[];
      setItems(loaded);

      // The progress lines for exactly these items. Skipped entirely when the month is empty —
      // an .in() on no ids is a request that can only return nothing.
      if (loaded.length === 0) { setUpdates([]); return; }
      const up = await supabase.from("cm_action_updates").select("*")
        .in("item_id", loaded.map((i) => i.id));
      if (up.error) throw up.error;
      setUpdates((up.data ?? []) as CmUpdate[]);
    } catch (e) {
      // A FAILED READ IS AN ERROR, never an empty month — the two look identical on screen and
      // one of them is "nothing was agreed" while the other is "we cannot tell you".
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { setLoading(true); void reload(); }, [reload]);

  const setStatus = useCallback(async (id: string, status: CmStatus) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    const upd = await supabase.from("cm_action_items").update({ status }).eq("id", id);
    if (upd.error) {
      setError(upd.error.message);
      // Roll the optimistic cycle back to the server's truth rather than leaving a pill lying.
      void reload();
    }
  }, [reload]);

  /* THE CALL SITE THIS FUNCTION NEVER HAD. cm_action_updates is HISTORY: an item that already
   * carries an update can take another, and the old one stays. reported_on is the day being
   * reported about — a calendar day, not an instant — and defaults to today at the database. */
  const addUpdate = useCallback(async (itemId: string, body: string, author: string | null, reportedOn?: string) => {
    const ins = await supabase.from("cm_action_updates")
      .insert({ item_id: itemId, body: body.trim(), author, ...(reportedOn ? { reported_on: reportedOn } : {}) })
      .select("*").single();
    if (ins.error || !ins.data) { setError(ins.error?.message ?? "Could not save the update"); return; }
    setUpdates((prev) => [...prev, ins.data as CmUpdate]);
  }, []);

  /* ── ADD ─────────────────────────────────────────────────────────────────────────────────────
   * The row shape is built by buildInsert, where 0158's three CHECK constraints live in one place.
   * NOT optimistic: the id and the defaults come back from the insert, and a row that Postgres
   * rejects must never appear on screen first. */
  const addItem = useCallback(async (input: NewItem) => {
    setError(null);
    const siblings = items.filter((i) =>
      input.kind === "goal" ? i.scope === "city" && i.city === input.city : i.scope === "team" && i.kind === input.kind);
    const ins = await supabase.from("cm_action_items")
      .insert(buildInsert(month, input, nextOrder(siblings))).select("*").single();
    if (ins.error || !ins.data) { setError(ins.error?.message ?? "Could not add that"); return; }
    setItems((prev) => [...prev, ins.data as CmItem]);
  }, [items, month]);

  const updateItem = useCallback(async (id: string, patch: { body?: string; owner?: string | null; source?: string }) => {
    setError(null);
    const clean = { ...patch, ...(patch.body !== undefined ? { body: patch.body.trim() } : {}) };
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...clean } as CmItem : i)));
    const upd = await supabase.from("cm_action_items").update(clean).eq("id", id);
    if (upd.error) { setError(upd.error.message); void reload(); }
  }, [reload]);

  /* DELETE TAKES THE UPDATES WITH IT — cm_action_updates is ON DELETE CASCADE (0158), so the
   * history goes with the row rather than being orphaned. Cleared locally too, or the page would
   * hold updates pointing at an item that no longer exists. */
  const deleteItem = useCallback(async (id: string) => {
    setError(null);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setUpdates((prev) => prev.filter((u) => u.item_id !== id));
    const del = await supabase.from("cm_action_items").delete().eq("id", id);
    if (del.error) { setError(del.error.message); void reload(); }
  }, [reload]);

  /* ONE ROW, NOT A RENUMBER. stepOrder returns the midpoint between the new neighbours, so moving
   * a row writes that row and nothing else. */
  const reorder = useCallback(async (siblings: readonly CmItem[], id: string, delta: -1 | 1) => {
    const next = stepOrder(siblings, id, delta);
    if (next === null) return;
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, sort_order: next } : i)));
    const upd = await supabase.from("cm_action_items").update({ sort_order: next }).eq("id", id);
    if (upd.error) { setError(upd.error.message); void reload(); }
  }, [reload]);

  /* CARRY FORWARD copies the goals only — not their statuses and not their progress. A goal that
   * was at risk in September starts October open, because it is a fresh month's target and
   * inheriting last month's verdict would state a judgement nobody made. Team items are NOT
   * carried: a thing to try is decided at a meeting, not repeated by default. */
  const carryForward = useCallback(async (fromMonth: string, toMonth: string): Promise<number> => {
    const src = await supabase.from("cm_action_items").select("*")
      .eq("month", fromMonth).eq("scope", "city");
    if (src.error) { setError(src.error.message); return 0; }
    const rows = (src.data ?? []) as CmItem[];
    if (rows.length === 0) return 0;
    const ins = await supabase.from("cm_action_items").insert(
      rows.map((r) => ({
        month: toMonth, scope: "city", kind: "goal", city: r.city,
        body: r.body, status: "open", sort_order: r.sort_order,
      })),
    );
    if (ins.error) { setError(ins.error.message); return 0; }
    await reload();
    return rows.length;
  }, [reload]);

  return { items, updates, loading, error, reload, setStatus, addUpdate, carryForward,
    addItem, updateItem, deleteItem, reorder };
}
