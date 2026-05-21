"use client";

// Per-city + per-week action items for the Slate Review tab. List +
// add-input + per-row checkbox/edit/delete. Persisted in
// slate_review_action_items, RLS-restricted to admins. Reloads on
// (city, weekStart) change so flipping either selector swaps the
// scoped list. Sort: open above done, then sort_order asc, then
// created_at desc (matches the Topics action items ordering vibe).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import SlateActionItemRow, {
  type SlateActionItem,
} from "./SlateActionItemRow";

function sortItems(rows: SlateActionItem[]): SlateActionItem[] {
  return [...rows].sort((a, b) => {
    if (a.is_done !== b.is_done) return a.is_done ? 1 : -1;
    const aSort = a.sort_order ?? Number.POSITIVE_INFINITY;
    const bSort = b.sort_order ?? Number.POSITIVE_INFINITY;
    if (aSort !== bSort) return aSort - bSort;
    return b.created_at.localeCompare(a.created_at);
  });
}

export default function SlateActionItems({
  city,
  weekStart,
}: {
  city: string;
  weekStart: string;
}) {
  const { appUser } = useAuth();
  const [items, setItems] = useState<SlateActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("slate_review_action_items")
      .select("*")
      .eq("city", city)
      .eq("week_start", weekStart);
    if (err) {
      setError(err.message);
      setItems([]);
    } else {
      setItems(sortItems((data ?? []) as SlateActionItem[]));
    }
    setLoading(false);
  }, [city, weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addItem() {
    const body = draft.trim();
    if (!body) return;
    const email = appUser?.email;
    if (!email) {
      setError("Not signed in.");
      return;
    }
    setAdding(true);
    setError(null);
    const { error: err } = await supabase
      .from("slate_review_action_items")
      .insert({
        city,
        week_start: weekStart,
        body,
        created_by: email,
      });
    setAdding(false);
    if (err) {
      setError(err.message);
      return;
    }
    setDraft("");
    void load();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
        <span>
          {city} · week of {weekStart}
        </span>
        {items.length > 0 && (
          <span className="font-normal normal-case text-deep-green/45">
            {items.filter((i) => !i.is_done).length} open ·{" "}
            {items.filter((i) => i.is_done).length} done
          </span>
        )}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addItem();
            }
          }}
          placeholder="Add an action item…"
          className="flex-1 rounded border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addItem()}
          disabled={adding || draft.trim() === ""}
          className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-coral/40 bg-coral-soft/40 px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs italic text-deep-green/45">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-xs italic text-deep-green/45">
          No action items for {city} · week of {weekStart} yet.
        </div>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <SlateActionItemRow key={it.id} item={it} onChange={load} />
          ))}
        </ul>
      )}
    </div>
  );
}
