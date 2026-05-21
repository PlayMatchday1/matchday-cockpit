"use client";

// Slate Review per-row action item. Mirrors ActionItemRow's visual
// + interaction pattern (checkbox toggles done with line-through +
// dim, inline-edit body on click, owner dropdown from org directory,
// optional due date with past-due coral accent, delete on hover)
// but writes to slate_review_action_items keyed on (city,
// week_start) instead of topic_action_items keyed on topic_id.
// Parallel-not-shared per the decision to keep the Topics surface
// untouched; if a third surface adds action items the two can be
// refactored to a callback-driven shared row.

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { partitionDirectory } from "@/lib/org";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import DirectoryOptions from "./DirectoryOptions";

export type SlateActionItem = {
  id: string;
  city: string;
  week_start: string;
  body: string;
  owner: string | null;
  due_date: string | null;
  is_done: boolean;
  done_at: string | null;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
  created_by: string;
};

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function SlateActionItemRow({
  item,
  onChange,
}: {
  item: SlateActionItem;
  onChange: () => void;
}) {
  const [editingBody, setEditingBody] = useState(false);
  const [draftBody, setDraftBody] = useState(item.body);
  const dir = useOrgDirectory();
  const partition = useMemo(
    () => (dir ? partitionDirectory(dir) : null),
    [dir],
  );

  const isPastDue =
    !!item.due_date && !item.is_done && item.due_date < todayIso();

  async function toggleDone() {
    const { error } = await supabase
      .from("slate_review_action_items")
      .update({
        is_done: !item.is_done,
        done_at: !item.is_done ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    if (error) return alert(error.message);
    onChange();
  }

  async function saveBody() {
    const trimmed = draftBody.trim();
    if (!trimmed || trimmed === item.body) {
      setDraftBody(item.body);
      setEditingBody(false);
      return;
    }
    const { error } = await supabase
      .from("slate_review_action_items")
      .update({ body: trimmed, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    setEditingBody(false);
    if (error) return alert(error.message);
    onChange();
  }

  async function setOwner(value: string) {
    const next = value || null;
    if (next === item.owner) return;
    const { error } = await supabase
      .from("slate_review_action_items")
      .update({ owner: next, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    if (error) return alert(error.message);
    onChange();
  }

  async function setDueDate(value: string) {
    const next = value || null;
    if (next === item.due_date) return;
    const { error } = await supabase
      .from("slate_review_action_items")
      .update({ due_date: next, updated_at: new Date().toISOString() })
      .eq("id", item.id);
    if (error) return alert(error.message);
    onChange();
  }

  async function remove() {
    if (!confirm("Delete this action item?")) return;
    const { error } = await supabase
      .from("slate_review_action_items")
      .delete()
      .eq("id", item.id);
    if (error) return alert(error.message);
    onChange();
  }

  return (
    <li
      className={`group flex items-start gap-3 rounded-lg border-l-4 px-3 py-2 transition ${
        isPastDue
          ? "border-coral bg-coral-soft/25"
          : "border-transparent hover:bg-cream-soft"
      } ${item.is_done ? "opacity-60" : ""}`}
    >
      <input
        type="checkbox"
        checked={item.is_done}
        onChange={toggleDone}
        className="mt-1 h-4 w-4 accent-mint"
        aria-label={
          item.is_done
            ? `Mark "${item.body}" not done`
            : `Mark "${item.body}" done`
        }
      />
      <div className="min-w-0 flex-1">
        {editingBody ? (
          <input
            autoFocus
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            onBlur={saveBody}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setDraftBody(item.body);
                setEditingBody(false);
              }
            }}
            className="w-full rounded border border-mint bg-white px-2 py-0.5 text-sm text-deep-green focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftBody(item.body);
              setEditingBody(true);
            }}
            className={`block w-full rounded px-1 text-left text-sm text-deep-green hover:bg-cream-soft ${
              item.is_done ? "line-through" : ""
            }`}
          >
            {item.body}
          </button>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-deep-green/60">
          <select
            value={item.owner ?? ""}
            onChange={(e) => setOwner(e.target.value)}
            className="rounded border border-cream-line bg-white px-1.5 py-0.5 text-xs text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Action item owner"
          >
            <option value="">No owner</option>
            {partition && <DirectoryOptions partition={partition} />}
          </select>
          <input
            type="date"
            value={item.due_date ?? ""}
            onChange={(e) => setDueDate(e.target.value)}
            className="rounded border border-cream-line bg-white px-1.5 py-0.5 text-xs text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Action item due date"
          />
          {item.due_date && (
            <button
              type="button"
              onClick={() => setDueDate("")}
              className="text-[11px] font-medium text-deep-green/40 transition hover:text-deep-green"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={remove}
        className="rounded-full p-1 text-deep-green/30 opacity-0 transition group-hover:opacity-100 hover:bg-coral-soft hover:text-coral"
        aria-label="Delete action item"
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </li>
  );
}
