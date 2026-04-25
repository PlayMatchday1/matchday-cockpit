"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import type { OrgDirectory, OrgGroup, OrgGroupKind } from "@/lib/org";
import { GROUP_KIND_LABEL } from "@/lib/org";
import { refetchOrgDirectory } from "@/lib/useOrgDirectory";
import InlineEdit from "./InlineEdit";
import OrgPersonRow from "./OrgPersonRow";

const KIND_PILL: Record<OrgGroupKind, string> = {
  org: "bg-mint-soft text-deep-green ring-mint/40",
  team: "bg-purple-soft text-purple-done ring-purple-done/30",
  city: "bg-coral-soft text-coral ring-coral/40",
};

export default function OrgGroupNode({
  group,
  dir,
}: {
  group: OrgGroup;
  dir: OrgDirectory;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingPerson, setAddingPerson] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);

  const childGroups = dir.groups.filter((g) => g.parent_id === group.id);
  const people = dir.people.filter((p) => p.group_id === group.id);
  const canAddSubgroup = group.kind === "org" || group.kind === "team";
  const newSubgroupKind: OrgGroupKind =
    group.kind === "org" ? "team" : "city";

  async function renameGroup(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) return;
    const { error } = await supabase
      .from("org_groups")
      .update({ name: trimmed })
      .eq("id", group.id);
    if (error) return alert(error.message);
    refetchOrgDirectory();
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="rounded p-0.5 text-deep-green/40 transition hover:bg-cream-line hover:text-deep-green"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <svg
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          <InlineEdit
            value={group.name}
            onSave={renameGroup}
            className="text-lg font-bold tracking-tight text-deep-green"
            inputClassName="text-lg font-bold tracking-tight text-deep-green"
          />
          <span
            className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${KIND_PILL[group.kind]}`}
          >
            {GROUP_KIND_LABEL[group.kind]}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          {canAddSubgroup && (
            <button
              type="button"
              onClick={() => setAddingGroup(true)}
              className="rounded-full border border-cream-line px-3 py-1 text-xs font-semibold text-deep-green transition hover:bg-cream-soft"
            >
              + Add {newSubgroupKind === "team" ? "team" : "city"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setAddingPerson(true)}
            className="rounded-full bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
          >
            + Add person
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4">
          {(people.length > 0 || addingPerson) && (
            <ul className="space-y-1">
              {people.map((p) => (
                <OrgPersonRow key={p.id} person={p} />
              ))}
              {addingPerson && (
                <AddPersonForm
                  groupId={group.id}
                  onDone={() => {
                    setAddingPerson(false);
                    refetchOrgDirectory();
                  }}
                  onCancel={() => setAddingPerson(false)}
                />
              )}
            </ul>
          )}

          {addingGroup && canAddSubgroup && (
            <AddGroupForm
              parentId={group.id}
              kind={newSubgroupKind}
              onDone={() => {
                setAddingGroup(false);
                refetchOrgDirectory();
              }}
              onCancel={() => setAddingGroup(false)}
            />
          )}

          {childGroups.length > 0 && (
            <div className="space-y-3 border-l-2 border-cream-line pl-4">
              {childGroups.map((c) => (
                <OrgGroupNode key={c.id} group={c} dir={dir} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddPersonForm({
  groupId,
  onDone,
  onCancel,
}: {
  groupId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("org_people").insert({
      name: name.trim(),
      title: title.trim() || null,
      group_id: groupId,
    });
    setSaving(false);
    if (error) return alert(error.message);
    onDone();
  }

  return (
    <li className="rounded-lg border border-mint bg-mint-soft/40 px-2 py-1.5">
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="min-w-0 flex-1 rounded border border-cream-line bg-white px-2 py-1 text-sm text-deep-green outline-none focus:border-deep-green"
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          className="min-w-0 flex-1 rounded border border-cream-line bg-white px-2 py-1 text-sm text-deep-green outline-none focus:border-deep-green"
        />
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="shrink-0 rounded bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-deep-green/60 hover:text-deep-green"
        >
          Cancel
        </button>
      </form>
    </li>
  );
}

function AddGroupForm({
  parentId,
  kind,
  onDone,
  onCancel,
}: {
  parentId: string;
  kind: OrgGroupKind;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("org_groups").insert({
      name: name.trim(),
      kind,
      parent_id: parentId,
    });
    setSaving(false);
    if (error) return alert(error.message);
    onDone();
  }

  return (
    <form
      onSubmit={save}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-mint bg-mint-soft/40 px-3 py-2"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`New ${kind} name`}
        className="min-w-0 flex-1 rounded border border-cream-line bg-white px-2 py-1 text-sm text-deep-green outline-none focus:border-deep-green"
      />
      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="shrink-0 rounded bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
      >
        Add {kind}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded px-2 py-1 text-xs font-medium text-deep-green/60 hover:text-deep-green"
      >
        Cancel
      </button>
    </form>
  );
}
