"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Doc } from "@/lib/types";

export default function DocsList() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editNote, setEditNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("docs")
      .select("*")
      .order("added_at", { ascending: false });
    if (error) setError(error.message);
    else setDocs((data ?? []) as Doc[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !newUrl.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("docs").insert({
      title: newTitle.trim(),
      url: newUrl.trim(),
      note: newNote.trim() || null,
    });
    setSaving(false);
    if (!error) {
      setNewTitle("");
      setNewUrl("");
      setNewNote("");
      setAdding(false);
      load();
    } else {
      alert(error.message);
    }
  }

  function startEdit(d: Doc) {
    setEditingId(d.id);
    setEditTitle(d.title);
    setEditUrl(d.url);
    setEditNote(d.note ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("docs")
      .update({
        title: editTitle.trim(),
        url: editUrl.trim(),
        note: editNote.trim() || null,
      })
      .eq("id", id);
    if (!error) {
      setEditingId(null);
      load();
    } else {
      alert(error.message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this doc?")) return;
    const { error } = await supabase.from("docs").delete().eq("id", id);
    if (!error) load();
  }

  return (
    <div className="space-y-4">
      {!adding ? (
        <button
          onClick={() => setAdding(true)}
          className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 hover:border-gray-400 hover:text-gray-900"
        >
          + Add doc
        </button>
      ) : (
        <form
          onSubmit={add}
          className="rounded-md border border-gray-200 bg-white p-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Title
              </label>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
                placeholder="e.g., Q2 OKRs"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Google Drive URL
              </label>
              <input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
                placeholder="https://docs.google.com/…"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-600">
                Note <span className="text-gray-400">(optional)</span>
              </label>
              <input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
                placeholder="e.g. Active through March"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setNewTitle("");
                setNewUrl("");
                setNewNote("");
              }}
              className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !newTitle.trim() || !newUrl.trim()}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save doc"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-left">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="py-2 pl-4 pr-4 font-medium">Title</th>
              <th className="py-2 pr-4 font-medium">URL</th>
              <th className="py-2 pr-4 font-medium">Note</th>
              <th className="py-2 pr-4 font-medium">Added</th>
              <th className="py-2 pr-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : docs.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-gray-500">
                  No docs yet.
                </td>
              </tr>
            ) : (
              docs.map((d) => (
                <tr
                  key={d.id}
                  className="border-t border-gray-200 hover:bg-gray-50"
                >
                  <td className="py-3 pl-4 pr-4 align-top">
                    {editingId === d.id ? (
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className="text-sm text-gray-900">{d.title}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 align-top">
                    {editingId === d.id ? (
                      <input
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        className="w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
                      />
                    ) : (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-sm text-blue-600 hover:underline"
                      >
                        {d.url}
                      </a>
                    )}
                  </td>
                  <td className="py-3 pr-4 align-top">
                    {editingId === d.id ? (
                      <input
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="e.g. Active through March"
                        className="w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
                      />
                    ) : d.note ? (
                      <span className="text-sm italic text-deep-green/60">
                        {d.note}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-4 align-top text-sm text-gray-500">
                    {relativeAdded(d.added_at)}
                  </td>
                  <td className="py-3 pr-4 align-top text-right">
                    {editingId === d.id ? (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-sm text-gray-500 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveEdit(d.id)}
                          className="rounded-md bg-gray-900 px-2 py-1 text-sm text-white hover:bg-gray-700"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => startEdit(d)}
                          className="text-sm text-gray-600 hover:text-gray-900"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => remove(d.id)}
                          className="text-sm text-gray-400 hover:text-red-600"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
