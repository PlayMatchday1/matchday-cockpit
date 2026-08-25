"use client";

// PAGE COMMENTS — one shared list for a whole page, on Slate Review's mechanism.
//
// SAME TABLE, SAME ROUTE, SAME LIST. `slate_notes` with kind='comment' (migration 0144),
// /api/slate-notes, and the NoteList component lifted out of SlateReviewView. Nothing here is a
// second comment system: what differs from Slate Review's CaptureBar is only the composer, because
// that one carries a live slot-parser readout and this one is prose.
//
// THE AUTHOR IS NEVER TYPED. The route stamps created_by from the signed-in session; there is no
// field for it in this component and no way to pass one.
//
// NO CITY, NO MATCH. A comment is scoped to the page. Match Promotion's grid shows every city at
// once, so a comment there is about the week's plan and not about one market — and it is one list,
// not a thread per fixture. The scope rule is a CHECK constraint, not a convention here.
//
// CONFIRM THEN APPEND, exactly as Slate Review does: the row renders only after the insert
// succeeds and only from the row the SERVER returned, so nothing appears that is not stored. On
// failure the typed text stays in the box.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import NoteList, { NOTE_C } from "./NoteList";
import type { SlateNote } from "@/lib/notes";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

export default function PageComments({
  weekStart,
  title = "Comments",
  placeholder = "Leave a comment for whoever reviews this week",
}: {
  /** Stamped onto the row so it carries a "week of Aug 24" tag, as Slate Review's notes do. */
  weekStart: string;
  title?: string;
  placeholder?: string;
}) {
  const [rows, setRows] = useState<SlateNote[]>([]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/slate-notes?scope=comments`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Could not load comments (${res.status})`); setRows([]); }
      else { setErr(null); setRows((j.notes ?? []) as SlateNote[]); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (busy) return;
    const raw = val.trim();
    if (!raw) return;
    setBusy(true); setErr(null);
    try {
      const res = await authFetch(`/api/slate-notes`, {
        method: "POST",
        // NO city key at all — not an empty string. The route refuses a comment carrying one.
        body: JSON.stringify({ kind: "comment", raw, weekStart }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.note) { setErr(j?.error || `Not saved (${res.status}) — your text is still here.`); return; }
      setRows((cs) => [j.note as SlateNote, ...cs]);
      setVal("");
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : String(e)} — your text is still here.`);
    } finally { setBusy(false); }
  };

  // HARD delete, and the row leaves only after the server confirms — same as the add.
  const drop = async (id: string) => {
    setErr(null);
    try {
      const res = await authFetch(`/api/slate-notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j?.error || `Could not delete (${res.status})`); return; }
      setRows((cs) => cs.filter((c) => c.id !== id));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="mx-5 mb-2 rounded-[11px] border bg-white px-3 py-2.5" data-testid="page-comments"
      style={{ borderColor: NOTE_C.line }}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.8px]" style={{ color: NOTE_C.muted }}>
          {title}
          {/* THE COUNT LIVES HERE, not on a tile. A comment is not attached to a match, so there is
              nothing per-tile to badge — this is how the list is findable without scrolling. */}
          {!loading && <> · <b data-testid="page-comments-count" style={{ color: NOTE_C.ink }}>{rows.length}</b></>}
        </span>
      </div>
      <div className="flex gap-2">
        <input value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          autoComplete="off" spellCheck={false} aria-label="Add a comment" data-testid="page-comment-input"
          placeholder={placeholder}
          className="h-[32px] min-w-0 flex-1 rounded-[8px] border px-2.5 text-[12.5px]" style={{ borderColor: NOTE_C.chipLine }} />
        <button type="button" onClick={() => void add()} disabled={busy} data-testid="page-comment-add"
          className="h-[32px] flex-none rounded-[8px] border px-3 text-[11.5px] font-bold disabled:opacity-50"
          style={{ background: NOTE_C.chipBg, borderColor: NOTE_C.chipLine, color: NOTE_C.ink }}>
          {busy ? "Saving…" : "Add"}
        </button>
      </div>
      {err && (
        <div data-testid="page-comment-error" className="mt-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-semibold"
          style={{ background: "#fdeeea", borderColor: "#f2c4b8", color: "#a8321f", overflowWrap: "anywhere" }}>{err}</div>
      )}
      {loading ? (
        <div className="mt-2 text-[11.5px]" style={{ color: NOTE_C.muted }}>Loading comments…</div>
      ) : rows.length > 0 && (
        <div className="mt-2 border-t pt-1" style={{ borderColor: NOTE_C.line }}>
          <NoteList notes={rows} onDelete={(id) => void drop(id)} />
        </div>
      )}
    </div>
  );
}
