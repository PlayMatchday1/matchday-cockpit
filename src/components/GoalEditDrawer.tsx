"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  STATUSES,
  type City,
  type Goal,
  type Scope,
  type Status,
} from "@/lib/types";
import { partitionDirectory } from "@/lib/org";
import { getNextSortOrder } from "@/lib/goals";
import { useClubhouseQuarter } from "@/lib/clubhouseQuarter";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import DirectoryOptions from "./DirectoryOptions";

export type DrawerState =
  | { mode: "edit"; goal: Goal }
  | { mode: "create"; scope: Scope; city?: City | null }
  | null;

export default function GoalEditDrawer({
  state,
  onClose,
  onSaved,
}: {
  state: DrawerState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = state !== null;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-deep-green/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col bg-cream shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
      >
        {state && (
          <DrawerForm
            key={state.mode === "edit" ? state.goal.id : `new-${state.scope}`}
            state={state}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

function DrawerForm({
  state,
  onClose,
  onSaved,
}: {
  state: NonNullable<DrawerState>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial =
    state.mode === "edit"
      ? {
          title: state.goal.title,
          owner: state.goal.owner,
          status: state.goal.status,
          progress: state.goal.progress,
          targetDate: state.goal.target_date ?? "",
        }
      : {
          title: "",
          owner: "",
          status: "Not started" as Status,
          progress: 0,
          targetDate: "",
        };

  const [title, setTitle] = useState(initial.title);
  const [owner, setOwner] = useState<string>(initial.owner);
  const [status, setStatus] = useState<Status>(initial.status);
  const [progress, setProgress] = useState(initial.progress);
  const [targetDate, setTargetDate] = useState<string>(initial.targetDate);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const quarter = useClubhouseQuarter();
  const dir = useOrgDirectory();
  const partition = useMemo(
    () => (dir ? partitionDirectory(dir) : null),
    [dir],
  );
  const ownerInDir = useMemo(() => {
    if (!partition) return false;
    return (
      partition.people.some((p) => p.name === owner) ||
      partition.teams.some((g) => g.name === owner) ||
      partition.cities.some((g) => g.name === owner) ||
      partition.root?.name === owner
    );
  }, [partition, owner]);

  async function save() {
    if (!title.trim() || !owner) return;
    setSaving(true);
    const target_date = targetDate || null;
    if (state.mode === "edit") {
      const updateData: Record<string, unknown> = {
        title: title.trim(),
        owner,
        status,
        progress,
        target_date,
      };
      if (progress !== state.goal.progress) {
        updateData.last_progress_change_at = new Date().toISOString();
      }
      const { error } = await supabase
        .from("goals")
        .update(updateData)
        .eq("id", state.goal.id);
      setSaving(false);
      if (error) return alert(error.message);
    } else {
      const sort_order = await getNextSortOrder(
        state.scope,
        state.city ?? null,
      );
      const { error } = await supabase.from("goals").insert({
        title: title.trim(),
        owner,
        status,
        progress,
        scope: state.scope,
        city: state.city ?? null,
        sort_order,
        target_date,
        quarter_key: quarter.key,
      });
      setSaving(false);
      if (error) return alert(error.message);
    }
    onSaved();
  }

  async function remove() {
    if (state.mode !== "edit") return;
    if (!confirm("Delete this goal? This cannot be undone.")) return;
    setDeleting(true);
    const { error } = await supabase
      .from("goals")
      .delete()
      .eq("id", state.goal.id);
    setDeleting(false);
    if (error) return alert(error.message);
    onSaved();
  }

  const quarterShort = quarter.label.split(" ")[0]; // "Q2", "Q3"
  const heading =
    state.mode === "edit"
      ? "Edit goal"
      : state.scope === "city" && state.city
        ? `New ${state.city} goal`
        : state.scope === "q2"
          ? `New ${quarterShort} goal`
          : `New ${state.scope} goal`;

  return (
    <>
      <div className="flex items-center justify-between border-b border-cream-line px-6 py-4">
        <h2 className="text-lg font-extrabold tracking-tight text-deep-green">
          {heading}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-deep-green/60 hover:bg-cream-line hover:text-deep-green"
          aria-label="Close"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="What's the goal?"
            className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
          />
        </Field>
        <Field label="Owner">
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="" disabled>
              Choose owner…
            </option>
            {owner && !ownerInDir && (
              <option value={owner}>{owner}</option>
            )}
            {partition && <DirectoryOptions partition={partition} />}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="w-full rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          >
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Target date">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            {targetDate && (
              <button
                type="button"
                onClick={() => setTargetDate("")}
                className="text-xs font-medium text-deep-green/60 transition hover:text-deep-green"
              >
                Clear
              </button>
            )}
          </div>
        </Field>
        <Field label="Progress">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              className="flex-1 accent-mint"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={progress}
              onChange={(e) =>
                setProgress(
                  Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                )
              }
              className="w-16 rounded-md border border-cream-line bg-cream-soft px-2 py-1.5 text-sm text-deep-green tabular-nums focus:border-deep-green focus:outline-none"
            />
            <span className="text-sm font-semibold text-deep-green/70">%</span>
          </div>
        </Field>
      </div>

      <div className="flex flex-col gap-3 border-t border-cream-line px-6 py-4">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm font-medium text-deep-green/70 hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !title.trim() || !owner}
            className="rounded-full bg-mint px-5 py-2 text-sm font-semibold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {state.mode === "edit" && (
          <button
            type="button"
            onClick={remove}
            disabled={deleting}
            className="self-start rounded-full bg-coral px-4 py-2 text-sm font-semibold text-white transition hover:bg-coral/90 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete goal"}
          </button>
        )}
      </div>
    </>
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
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </label>
  );
}
