"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Doc, DocSection } from "@/lib/types";

function relativeAdded(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) {
    const weeks = Math.round(days / 7);
    return `${weeks}w ago`;
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function normalizeDocSortOrders(docs: Doc[]): Promise<Doc[]> {
  const updates = docs.map((d, i) =>
    supabase.from("docs").update({ sort_order: i }).eq("id", d.id),
  );
  await Promise.all(updates);
  return docs.map((d, i) => ({ ...d, sort_order: i }));
}

export default function DocSectionCard({
  section,
  docs,
  allSections,
  canMoveUp,
  canMoveDown,
  onMoveSection,
  onSectionDeleted,
  onChange,
}: {
  section: DocSection;
  docs: Doc[];
  allSections: DocSection[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveSection: (dir: "up" | "down") => void;
  onSectionDeleted: () => void;
  onChange: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(section.title);

  const [adding, setAdding] = useState(false);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const otherSections = allSections.filter((s) => s.id !== section.id);

  async function saveTitle() {
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === section.title) {
      setDraftTitle(section.title);
      setEditingTitle(false);
      return;
    }
    const { error } = await supabase
      .from("doc_sections")
      .update({ title: trimmed })
      .eq("id", section.id);
    setEditingTitle(false);
    if (error) return alert(error.message);
    onChange();
  }

  function startDelete() {
    setPendingDelete(true);
    setMoveTargetId(otherSections[0]?.id ?? null);
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    if (docs.length > 0) {
      if (moveTargetId === null) {
        setDeleting(false);
        return;
      }
      const moveErr = await supabase
        .from("docs")
        .update({ section_id: moveTargetId })
        .eq("section_id", section.id);
      if (moveErr.error) {
        setDeleting(false);
        return alert(moveErr.error.message);
      }
    }
    const { error } = await supabase
      .from("doc_sections")
      .delete()
      .eq("id", section.id);
    setDeleting(false);
    if (error) return alert(error.message);
    setPendingDelete(false);
    onSectionDeleted();
  }

  async function moveDoc(docId: string, dir: "up" | "down") {
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx === -1) return;
    const targetIdx = dir === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= docs.length) return;

    let working = docs;
    const orders = new Set(docs.map((d) => d.sort_order));
    if (orders.size !== docs.length) {
      working = await normalizeDocSortOrders(docs);
    }

    const a = working[idx];
    const b = working[targetIdx];
    const aOrder = a.sort_order;
    const bOrder = b.sort_order;

    const r1 = await supabase
      .from("docs")
      .update({ sort_order: bOrder })
      .eq("id", a.id);
    if (r1.error) return alert(r1.error.message);
    const r2 = await supabase
      .from("docs")
      .update({ sort_order: aOrder })
      .eq("id", b.id);
    if (r2.error) return alert(r2.error.message);
    onChange();
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded p-1 text-deep-green/40 transition hover:bg-cream-line hover:text-deep-green"
            aria-label={collapsed ? "Expand section" : "Collapse section"}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
          {editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                else if (e.key === "Escape") {
                  setDraftTitle(section.title);
                  setEditingTitle(false);
                }
              }}
              className="min-w-0 flex-1 rounded border border-mint bg-white px-2 py-0.5 text-base font-bold tracking-tight text-deep-green focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftTitle(section.title);
                setEditingTitle(true);
              }}
              className="min-w-0 truncate rounded px-1 text-left text-base font-bold tracking-tight text-deep-green hover:bg-cream-soft"
            >
              {section.title}
            </button>
          )}
          <span className="shrink-0 text-xs text-deep-green/45">
            {docs.length} {docs.length === 1 ? "doc" : "docs"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn
            onClick={() => onMoveSection("up")}
            disabled={!canMoveUp}
            label={`Move ${section.title} up`}
          >
            <ChevronUp className="h-4 w-4" />
          </IconBtn>
          <IconBtn
            onClick={() => onMoveSection("down")}
            disabled={!canMoveDown}
            label={`Move ${section.title} down`}
          >
            <ChevronDown className="h-4 w-4" />
          </IconBtn>
          <button
            type="button"
            onClick={startDelete}
            className="rounded px-2 py-1 text-xs font-medium text-deep-green/45 transition hover:bg-coral-soft hover:text-coral"
          >
            Delete
          </button>
        </div>
      </div>

      {pendingDelete && (
        <div className="border-t border-cream-line/60 bg-cream-soft px-5 py-4">
          {docs.length === 0 ? (
            <DeleteEmptyConfirm
              deleting={deleting}
              onConfirm={confirmDelete}
              onCancel={() => setPendingDelete(false)}
            />
          ) : otherSections.length === 0 ? (
            <DeleteBlocked
              count={docs.length}
              onCancel={() => setPendingDelete(false)}
            />
          ) : (
            <DeleteWithMove
              count={docs.length}
              targetId={moveTargetId}
              setTargetId={setMoveTargetId}
              targets={otherSections}
              deleting={deleting}
              onConfirm={confirmDelete}
              onCancel={() => setPendingDelete(false)}
            />
          )}
        </div>
      )}

      {!collapsed && (
        <div className="border-t border-cream-line/60 px-5 py-4">
          {adding ? (
            <DocAddForm
              defaultSectionId={section.id}
              allSections={allSections}
              docsInSection={docs}
              onCancel={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                onChange();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-full bg-mint-soft px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint hover:text-deep-green"
            >
              + Add doc
            </button>
          )}

          {docs.length > 0 ? (
            <div className="mt-4 -mx-2 overflow-x-auto px-2">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                    <th className="px-2 py-2 text-left">Title</th>
                    <th className="px-2 py-2 text-left">URL</th>
                    <th className="px-2 py-2 text-left">Note</th>
                    <th className="px-2 py-2 text-left">Added</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d, i) =>
                    editingDocId === d.id ? (
                      <tr key={d.id} className="border-t border-cream-line/40 bg-cream-soft/40">
                        <td colSpan={5} className="px-2 py-3">
                          <DocEditForm
                            doc={d}
                            allSections={allSections}
                            onCancel={() => setEditingDocId(null)}
                            onSaved={() => {
                              setEditingDocId(null);
                              onChange();
                            }}
                          />
                        </td>
                      </tr>
                    ) : (
                      <DocRow
                        key={d.id}
                        doc={d}
                        canMoveUp={i > 0}
                        canMoveDown={i < docs.length - 1}
                        onMoveUp={() => moveDoc(d.id, "up")}
                        onMoveDown={() => moveDoc(d.id, "down")}
                        onEdit={() => setEditingDocId(d.id)}
                        onChanged={onChange}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 text-xs italic text-deep-green/45">
              No docs in this section yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DocRow({
  doc,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onChanged,
}: {
  doc: Doc;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  async function remove() {
    if (!confirm("Delete this doc?")) return;
    const { error } = await supabase.from("docs").delete().eq("id", doc.id);
    if (error) return alert(error.message);
    onChanged();
  }

  return (
    <tr className="border-t border-cream-line/40 transition hover:bg-cream-soft/60">
      <td className="px-2 py-2 align-top text-sm font-semibold text-deep-green">
        {doc.title}
      </td>
      <td className="px-2 py-2 align-top">
        <a
          href={doc.url}
          target="_blank"
          rel="noreferrer"
          className="break-all text-sm text-mint-hover hover:underline"
        >
          {doc.url}
        </a>
      </td>
      <td className="px-2 py-2 align-top">
        {doc.note ? (
          <span className="text-sm italic text-deep-green/60">{doc.note}</span>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-2 py-2 align-top text-sm text-deep-green/55">
        {relativeAdded(doc.added_at)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 align-top text-right">
        <div className="flex items-center justify-end gap-0.5">
          <IconBtn
            onClick={onMoveUp}
            disabled={!canMoveUp}
            label={`Move ${doc.title} up`}
          >
            <ChevronUp className="h-4 w-4" />
          </IconBtn>
          <IconBtn
            onClick={onMoveDown}
            disabled={!canMoveDown}
            label={`Move ${doc.title} down`}
          >
            <ChevronDown className="h-4 w-4" />
          </IconBtn>
          <button
            type="button"
            onClick={onEdit}
            className="rounded px-2 py-1 text-xs font-medium text-deep-green/60 transition hover:text-deep-green"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={remove}
            className="rounded px-2 py-1 text-xs font-medium text-deep-green/40 transition hover:bg-coral-soft hover:text-coral"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function DocAddForm({
  defaultSectionId,
  allSections,
  docsInSection,
  onCancel,
  onSaved,
}: {
  defaultSectionId: number;
  allSections: DocSection[];
  docsInSection: Doc[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [sectionId, setSectionId] = useState<number>(defaultSectionId);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !url.trim() || saving) return;
    setSaving(true);

    let nextSort = 0;
    if (sectionId === defaultSectionId && docsInSection.length > 0) {
      nextSort =
        Math.max(...docsInSection.map((d) => d.sort_order ?? 0)) + 1;
    } else {
      const { data: maxRow } = await supabase
        .from("docs")
        .select("sort_order")
        .eq("section_id", sectionId)
        .order("sort_order", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      nextSort =
        (((maxRow as { sort_order: number | null } | null)?.sort_order ?? 0) as number) + 1;
    }

    const { error } = await supabase.from("docs").insert({
      title: title.trim(),
      url: url.trim(),
      note: note.trim() || null,
      section_id: sectionId,
      sort_order: nextSort,
    });
    setSaving(false);
    if (error) return alert(error.message);
    onSaved();
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-cream-line bg-cream-soft p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Q2 OKRs"
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
        <Field label="Section">
          <select
            value={sectionId}
            onChange={(e) => setSectionId(Number(e.target.value))}
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          >
            {allSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Google Drive URL" colSpan>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/…"
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
        <Field label="Note (optional)" colSpan>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Active through March"
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-4 py-1.5 text-sm font-medium text-deep-green/70 hover:text-deep-green"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !title.trim() || !url.trim()}
          className="rounded-full bg-mint px-4 py-1.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save doc"}
        </button>
      </div>
    </form>
  );
}

function DocEditForm({
  doc,
  allSections,
  onCancel,
  onSaved,
}: {
  doc: Doc;
  allSections: DocSection[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [url, setUrl] = useState(doc.url);
  const [note, setNote] = useState(doc.note ?? "");
  const [sectionId, setSectionId] = useState<number>(
    doc.section_id ?? allSections[0]?.id ?? 0,
  );
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !url.trim() || saving) return;
    setSaving(true);

    const updates: Record<string, unknown> = {
      title: title.trim(),
      url: url.trim(),
      note: note.trim() || null,
      section_id: sectionId,
    };

    if (sectionId !== doc.section_id) {
      const { data: maxRow } = await supabase
        .from("docs")
        .select("sort_order")
        .eq("section_id", sectionId)
        .order("sort_order", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      updates.sort_order =
        (((maxRow as { sort_order: number | null } | null)?.sort_order ?? 0) as number) + 1;
    }

    const { error } = await supabase
      .from("docs")
      .update(updates)
      .eq("id", doc.id);
    setSaving(false);
    if (error) return alert(error.message);
    onSaved();
  }

  return (
    <form onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
        <Field label="Section">
          <select
            value={sectionId}
            onChange={(e) => setSectionId(Number(e.target.value))}
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          >
            {allSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL" colSpan>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
        <Field label="Note" colSpan>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Active through March"
            className="w-full rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-4 py-1.5 text-sm font-medium text-deep-green/70 hover:text-deep-green"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !title.trim() || !url.trim()}
          className="rounded-full bg-mint px-4 py-1.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function DeleteEmptyConfirm({
  deleting,
  onConfirm,
  onCancel,
}: {
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-deep-green/80">Delete this section?</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-xs font-medium text-deep-green/70 hover:text-deep-green"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={deleting}
          className="rounded-full bg-coral px-3 py-1 text-xs font-bold text-white transition hover:bg-coral/90 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function DeleteBlocked({
  count,
  onCancel,
}: {
  count: number;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-deep-green/80">
        This section has {count} {count === 1 ? "doc" : "docs"}. Create another
        section first to move them to.
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-full bg-mint px-3 py-1 text-xs font-bold text-deep-green hover:bg-mint-hover"
      >
        OK
      </button>
    </div>
  );
}

function DeleteWithMove({
  count,
  targetId,
  setTargetId,
  targets,
  deleting,
  onConfirm,
  onCancel,
}: {
  count: number;
  targetId: number | null;
  setTargetId: (id: number) => void;
  targets: DocSection[];
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-deep-green/80">
        This section has {count} {count === 1 ? "doc" : "docs"}. Move them to:
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          value={targetId ?? ""}
          onChange={(e) => setTargetId(Number(e.target.value))}
          className="rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
        >
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-3 py-1 text-xs font-medium text-deep-green/70 hover:text-deep-green"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting || targetId === null}
            className="rounded-full bg-coral px-3 py-1 text-xs font-bold text-white transition hover:bg-coral/90 disabled:opacity-50"
          >
            {deleting ? "Working…" : "Move and delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${colSpan ? "sm:col-span-2" : ""}`}>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </label>
  );
}

function IconBtn({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded p-1 text-deep-green/40 transition hover:bg-cream-line hover:text-deep-green disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-deep-green/40"
    >
      {children}
    </button>
  );
}
