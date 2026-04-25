"use client";

import { supabase } from "@/lib/supabase";
import type { OrgPerson } from "@/lib/org";
import { refetchOrgDirectory } from "@/lib/useOrgDirectory";
import InlineEdit from "./InlineEdit";

export default function OrgPersonRow({ person }: { person: OrgPerson }) {
  async function update(field: "name" | "title", value: string) {
    const trimmed = value.trim();
    const next = field === "title" ? trimmed || null : trimmed;
    if (next === person[field]) return;
    if (field === "name" && !trimmed) return;
    const { error } = await supabase
      .from("org_people")
      .update({ [field]: next })
      .eq("id", person.id);
    if (error) return alert(error.message);
    refetchOrgDirectory();
  }

  async function remove() {
    if (!confirm(`Delete ${person.name}?`)) return;
    const { error } = await supabase
      .from("org_people")
      .delete()
      .eq("id", person.id);
    if (error) return alert(error.message);
    refetchOrgDirectory();
  }

  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-cream-soft">
      <InlineEdit
        value={person.name}
        onSave={(v) => update("name", v)}
        className="font-bold text-deep-green"
        inputClassName="font-bold text-deep-green"
      />
      <InlineEdit
        value={person.title ?? ""}
        onSave={(v) => update("title", v)}
        className="text-sm text-deep-green/60"
        inputClassName="text-sm text-deep-green/80"
        placeholder="Add title"
      />
      {person.is_external && (
        <span className="inline-flex rounded-full bg-coral-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-coral ring-1 ring-inset ring-coral/40">
          External
        </span>
      )}
      <button
        type="button"
        onClick={remove}
        className="ml-auto rounded-full p-1 text-deep-green/30 opacity-0 transition group-hover:opacity-100 hover:bg-coral-soft hover:text-coral"
        aria-label={`Delete ${person.name}`}
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
