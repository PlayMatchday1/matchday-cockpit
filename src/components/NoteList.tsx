"use client";

// NOTE LIST — the attributed, deletable list Slate Review has always shown, as a component.
//
// LIFTED OUT OF SlateReviewView.tsx UNCHANGED. Same markup, same test ids, same colours, so
// verify-slate-notes runs against it without an edit. It is here rather than there so Match
// Promotion can render the SAME list instead of growing a second one.
//
// PRESENTATIONAL ONLY. It fetches nothing and writes nothing — the caller owns the rows and the
// delete. That is what lets one component serve a city-scoped list and a page-scoped one without
// knowing which it is.
//
// THE AUTHOR IS NEVER AN INPUT. `createdBy` comes off the row, which the route stamped from the
// signed-in session. There is no prop for it and no way to pass one.

import { shortWho, weekTag, type SlateNote } from "@/lib/notes";

/** Slate Review's palette, moved with the markup so the list looks identical on both pages. */
export const NOTE_C = {
  ink: "#12241d",
  muted: "#5b6b64",
  hair: "#e7ece9",
  line: "#d4ded9",
  chipBg: "#f1f5f3",
  chipLine: "#dde5e1",
  gold: "#e6c34a",
  goldInk: "#6b5310",
} as const;

export function NoteRow({ note, onDelete }: { note: SlateNote; onDelete: (id: string) => void }) {
  const c = note;
  return (
    <div data-testid="slate-note-row" data-kind={c.kind} data-id={c.id}
      className="flex items-start gap-2.5 border-t py-[7px] first:border-t-0" style={{ borderColor: NOTE_C.hair }}>
      <span className="mt-0.5 flex-none rounded-[4px] border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.7px]"
        style={c.kind === "proposal"
          ? { background: "#fdf3d9", borderColor: NOTE_C.gold, color: NOTE_C.goldInk }
          : { background: NOTE_C.chipBg, borderColor: NOTE_C.chipLine, color: NOTE_C.muted }}>
        {c.kind === "proposal" ? "SLOT" : "NOTE"}
      </span>
      <span className="min-w-0 flex-1" style={{ overflowWrap: "anywhere" }}>
        {c.kind === "proposal" ? (
          <>
            <span className="block text-[12.5px] font-semibold" style={{ color: NOTE_C.ink }}>{c.day} {c.timeTxt} · {c.fieldTxt}</span>
            {/* the RAW text is stored and shown — the parser guesses, so the typed words stay reviewable */}
            <span className="block text-[11px]" style={{ color: NOTE_C.muted }}>typed: “{c.raw}”</span>
          </>
        ) : (
          <span data-testid="slate-note-raw" className="block text-[12.5px] font-semibold" style={{ color: NOTE_C.ink }}>{c.raw}</span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px]" style={{ color: NOTE_C.muted }}>
          {/* a note outlives its week, so it says which week it was written on */}
          <span data-testid="slate-note-week" className="rounded-[4px] border px-1 py-px font-bold"
            style={{ background: NOTE_C.chipBg, borderColor: NOTE_C.chipLine }}>{weekTag(c.weekStart)}</span>
          <span data-testid="slate-note-who">{shortWho(c.createdBy)}</span>
        </span>
      </span>
      <button type="button" onClick={() => onDelete(c.id)} aria-label="Remove" data-testid="slate-note-delete"
        className="h-[28px] w-[28px] flex-none rounded-[8px] border text-[12px]"
        style={{ borderColor: NOTE_C.chipLine, color: NOTE_C.muted }}>✕</button>
    </div>
  );
}

export default function NoteList({ notes, onDelete }: { notes: SlateNote[]; onDelete: (id: string) => void }) {
  return <>{notes.map((n) => <NoteRow key={n.id} note={n} onDelete={onDelete} />)}</>;
}
