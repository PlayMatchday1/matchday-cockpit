"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  DEPARTMENTS,
  DEPARTMENT_LABEL,
  type Department,
} from "@/lib/topics";
import { refetchTopics } from "@/lib/useTopics";
import { useClubhouseQuarter } from "@/lib/clubhouseQuarter";

export default function NewTopicModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const quarter = useClubhouseQuarter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // "" represents the General/Org-wide default (department=null).
  const [department, setDepartment] = useState<Department | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);

    const { data: maxRow } = await supabase
      .from("topics")
      .select("sort_order")
      .eq("status", "open")
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const sort_order =
      (((maxRow as { sort_order: number | null } | null)?.sort_order ?? 0) as number) + 1;

    const { data, error: insertErr } = await supabase
      .from("topics")
      .insert({
        title: title.trim(),
        description: description.trim() || null,
        department: department || null,
        status: "open",
        sort_order,
        quarter_key: quarter.key,
      })
      .select()
      .single();
    setSaving(false);
    if (insertErr || !data) {
      setError(insertErr?.message ?? "Failed to create topic");
      return;
    }

    refetchTopics();
    onCreated((data as { id: string }).id);
  }

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-deep-green/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="absolute left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-extrabold tracking-tight text-deep-green">
          New topic
        </h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <Field label="Title">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What is this topic about?"
              className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional context…"
              className="w-full resize-none rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
            />
          </Field>
          <Field label="Department">
            <select
              value={department}
              onChange={(e) =>
                setDepartment(e.target.value as Department | "")
              }
              className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              <option value="">General</option>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {DEPARTMENT_LABEL[d]}
                </option>
              ))}
            </select>
          </Field>
          {error && (
            <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs text-coral">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm font-medium text-deep-green/70 hover:text-deep-green"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || saving}
              className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </label>
  );
}
