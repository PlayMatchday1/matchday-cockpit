"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Doc, DocSection } from "@/lib/types";
import DocSectionCard from "./DocSectionCard";

async function normalizeSectionSortOrders(
  sections: DocSection[],
): Promise<DocSection[]> {
  const updates = sections.map((s, i) =>
    supabase.from("doc_sections").update({ sort_order: i }).eq("id", s.id),
  );
  await Promise.all(updates);
  return sections.map((s, i) => ({ ...s, sort_order: i }));
}

export default function DocsList() {
  const [sections, setSections] = useState<DocSection[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addingSection, setAddingSection] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [savingSection, setSavingSection] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [sRes, dRes] = await Promise.all([
      supabase
        .from("doc_sections")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("docs")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("added_at", { ascending: false }),
    ]);
    if (sRes.error) {
      setError(sRes.error.message);
      setLoading(false);
      return;
    }
    if (dRes.error) {
      setError(dRes.error.message);
      setLoading(false);
      return;
    }
    setSections((sRes.data ?? []) as DocSection[]);
    setDocs((dRes.data ?? []) as Doc[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addSection(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newSectionTitle.trim();
    if (!trimmed || savingSection) return;
    setSavingSection(true);
    const nextSort =
      sections.length > 0
        ? Math.max(...sections.map((s) => s.sort_order ?? 0)) + 1
        : 0;
    const { error } = await supabase.from("doc_sections").insert({
      title: trimmed,
      sort_order: nextSort,
    });
    setSavingSection(false);
    if (error) return alert(error.message);
    setNewSectionTitle("");
    setAddingSection(false);
    load();
  }

  async function moveSection(sectionId: number, dir: "up" | "down") {
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx === -1) return;
    const targetIdx = dir === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= sections.length) return;

    let working = sections;
    const orders = new Set(sections.map((s) => s.sort_order));
    if (orders.size !== sections.length) {
      working = await normalizeSectionSortOrders(sections);
      setSections(working);
    }

    const a = working[idx];
    const b = working[targetIdx];
    const aOrder = a.sort_order;
    const bOrder = b.sort_order;

    const r1 = await supabase
      .from("doc_sections")
      .update({ sort_order: bOrder })
      .eq("id", a.id);
    if (r1.error) return alert(r1.error.message);
    const r2 = await supabase
      .from("doc_sections")
      .update({ sort_order: aOrder })
      .eq("id", b.id);
    if (r2.error) return alert(r2.error.message);
    load();
  }

  return (
    <div className="space-y-6">
      {addingSection ? (
        <form
          onSubmit={addSection}
          className="flex flex-wrap items-center gap-2 rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10"
        >
          <input
            autoFocus
            value={newSectionTitle}
            onChange={(e) => setNewSectionTitle(e.target.value)}
            placeholder="Section title"
            className="min-w-0 flex-1 rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
          <button
            type="submit"
            disabled={savingSection || !newSectionTitle.trim()}
            className="rounded-full bg-mint px-4 py-1.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {savingSection ? "Adding…" : "Add section"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAddingSection(false);
              setNewSectionTitle("");
            }}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-deep-green/70 hover:text-deep-green"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAddingSection(true)}
          className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
        >
          + Add section
        </button>
      )}

      {error && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading…
        </div>
      ) : sections.length === 0 ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          No sections yet. Add one to start grouping docs.
        </div>
      ) : (
        sections.map((s, i) => (
          <DocSectionCard
            key={s.id}
            section={s}
            docs={docs.filter((d) => d.section_id === s.id)}
            allSections={sections}
            canMoveUp={i > 0}
            canMoveDown={i < sections.length - 1}
            onMoveSection={(dir) => moveSection(s.id, dir)}
            onSectionDeleted={load}
            onChange={load}
          />
        ))
      )}
    </div>
  );
}
