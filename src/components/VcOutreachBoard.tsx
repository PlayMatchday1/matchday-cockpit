"use client";

/* VC OUTREACH — a third kanban over the shared engine.
 *
 * ITS OWN RENDERER, like FieldPipelineBoard, and for the same reason that one exists: the shared
 * KanbanBoard drives /tech/tech-roadmap, which must render byte-identical. A card here leads with a
 * fit grade and a fund focus; a roadmap card does not. Sharing the renderer would mean branching it
 * on board_type in a dozen places, which is how the first one got hard to change.
 *
 * NO EXPLAINER COPY. The source file carried a description on every stage — "Ready for an intro or
 * initial email" — and it does not come across. No legend for the grades either: A/B/C/D is a
 * grading anyone reading this board already understands.
 *
 * TAILWIND PLUS INLINE STYLE OBJECTS FOR COLOUR, no styled-jsx anywhere. Field Pipeline is built
 * that way and is the one board that has never been bitten by the scoping trap the rest of the
 * estate has.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useKanbanBoard } from "@/lib/useKanbanBoard";
import KanbanCardModal from "@/components/KanbanCardModal";
import {
  VC_OUTREACH_STAGES, vcWaveLabel, vcFitGrade, vcIsWarm,
  type KanbanCard,
} from "@/lib/kanban";

const COLLAPSE_KEY = "vcoutreach:collapsed:v1";

/* GRADE COLOURS. Four, and nothing for ungraded — 6 of the 90 are blank or "Unknown" and they are
 * not a fifth grade, so they get the neutral chip rather than a colour implying a rank. */
const FIT_HUE: Record<string, { bg: string; fg: string }> = {
  A: { bg: "#0F7A46", fg: "#FFFFFF" },
  B: { bg: "#2F8FBF", fg: "#FFFFFF" },
  C: { bg: "#C88A1E", fg: "#FFFFFF" },
  D: { bg: "#8A94A0", fg: "#FFFFFF" },
};
const OWNER_HUE = ["#1F7A4D", "#2F6FD0", "#8A4FBF", "#C0672A", "#0E7C86", "#A33D5E", "#5C6F2A"];
const hueFor = (name: string) => OWNER_HUE[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % OWNER_HUE.length];
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");

const readLS = <T,>(k: string, fb: T): T => {
  try { const raw = window.localStorage.getItem(k); return raw ? (JSON.parse(raw) as T) : fb; } catch { return fb; }
};
const writeLS = (k: string, v: unknown) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

type Contact = { name?: string; title?: string; email?: string };
const d = (c: KanbanCard) => c.data as Record<string, unknown>;
const owners = (c: KanbanCard): string[] => (Array.isArray(d(c).owners) ? (d(c).owners as string[]) : []).filter(Boolean);
const contacts = (c: KanbanCard): Contact[] => (Array.isArray(d(c).contacts) ? (d(c).contacts as Contact[]) : []);
const focus = (c: KanbanCard) => String(d(c).fund_focus ?? "");
const wave = (c: KanbanCard) => vcWaveLabel(String(d(c).wave_raw ?? ""));
const grade = (c: KanbanCard) => vcFitGrade(String(d(c).fit_raw ?? ""));
const warm = (c: KanbanCard) => vcIsWarm(d(c).warm_raw);

export default function VcOutreachBoard() {
  const api = useKanbanBoard("vc_outreach");
  const { cards, loading, error } = api;

  const [q, setQ] = useState("");
  /* NO FILTER DEFAULTS TO A SUBSET. Applications shipped with a time filter defaulting to a window
   * that happened to be empty and the page opened blank, reading as broken. Every chip here starts
   * on "all". */
  const [fit, setFit] = useState<string>("all");
  const [wv, setWv] = useState<string>("all");
  const [own, setOwn] = useState<string>("all");
  const [warmOnly, setWarmOnly] = useState(false);

  const [collapsedStored, setCollapsedStored] = useState<Record<string, boolean>>(() => readLS(COLLAPSE_KEY, {}));
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "edit"; card: KanbanCard } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const draggingId = useRef<string | null>(null);

  const matches = useCallback((c: KanbanCard) => {
    const needle = q.trim().toLowerCase();
    if (needle) {
      const hay = [c.title, focus(c), ...contacts(c).map((x) => x.name ?? "")].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (fit !== "all" && grade(c) !== fit) return false;
    if (wv !== "all" && wave(c) !== wv) return false;
    if (own !== "all" && !(own === "__none" ? owners(c).length === 0 : owners(c).includes(own))) return false;
    if (warmOnly && !warm(c)) return false;
    return true;
  }, [q, fit, wv, own, warmOnly]);

  const shown = useMemo(() => cards.filter(matches), [cards, matches]);
  const byStage = useCallback((id: string) => shown.filter((c) => c.stage === id), [shown]);

  /* COUNTS COMPOSE, each axis counting against everything except itself — the rule the Field
   * Pipeline chips and the Applications chips both follow. A chip promising 21 that yields 3 is
   * worse than a chip with no number. */
  const countBy = useCallback((axis: "fit" | "wave" | "owner", value: string) => cards.filter((c) => {
    const needle = q.trim().toLowerCase();
    if (needle && ![c.title, focus(c), ...contacts(c).map((x) => x.name ?? "")].join(" ").toLowerCase().includes(needle)) return false;
    if (warmOnly && !warm(c)) return false;
    if (axis !== "fit" && fit !== "all" && grade(c) !== fit) return false;
    if (axis !== "wave" && wv !== "all" && wave(c) !== wv) return false;
    if (axis !== "owner" && own !== "all" && !(own === "__none" ? owners(c).length === 0 : owners(c).includes(own))) return false;
    if (value === "all") return true;
    if (axis === "fit") return grade(c) === value;
    if (axis === "wave") return wave(c) === value;
    return value === "__none" ? owners(c).length === 0 : owners(c).includes(value);
  }).length, [cards, q, warmOnly, fit, wv, own]);

  const waveOptions = useMemo(
    () => ["High", "Medium", "Low", "Hold", "Exclude"].filter((w) => cards.some((c) => wave(c) === w)), [cards]);
  const ownerOptions = useMemo(
    () => [...new Set(cards.flatMap(owners))].sort(), [cards]);

  /* COLLAPSED WHEN EMPTY, and that is the layout. All 90 land in Not Contacted, so a seven-column
   * board on day one is one pile and six blank panels. A collapsed stage is a 48px rail against
   * 298px open; seven of them fit without the board scrolling sideways. It opens when a card
   * lands in it — see moveCardToStage. */
  const isCollapsed = (stageId: string, rawCount: number) =>
    stageId in collapsedStored ? collapsedStored[stageId] : rawCount === 0;
  const toggle = (stageId: string, rawCount: number) => {
    const next = { ...collapsedStored, [stageId]: !isCollapsed(stageId, rawCount) };
    setCollapsedStored(next); writeLS(COLLAPSE_KEY, next);
  };

  const moveCardToStage = useCallback(async (cardId: string, stageId: string) => {
    const moving = cards.find((c) => c.id === cardId);
    if (!moving || moving.stage === stageId) return;
    // OPEN THE DESTINATION FIRST, so the card never disappears into a 48px rail.
    setCollapsedStored((prev) => {
      const rawCount = cards.filter((c) => c.stage === stageId).length;
      const wasColl = stageId in prev ? prev[stageId] : rawCount === 0;
      if (!wasColl) return prev;
      const next = { ...prev, [stageId]: false }; writeLS(COLLAPSE_KEY, next); return next;
    });
    const ok = await api.updateCard(cardId, { stage: stageId });
    if (!ok) setToast("Couldn't move that firm — it's back where it was.");
  }, [cards, api]);

  const Chip = ({ on, onClick, children, tone }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: string }) => (
    <button type="button" onClick={onClick} aria-pressed={on}
      className="rounded-full border px-3 py-1 text-[12.5px] font-semibold transition"
      style={on
        ? { background: tone ?? "#0F3323", borderColor: tone ?? "#0F3323", color: "#fff" }
        : { background: "#fff", borderColor: "#E0E7E2", color: "#3C4F44" }}>
      {children}
    </button>
  );

  if (error) return <p className="p-6 text-[13px] text-red-700" data-testid="vc-error">{error}</p>;

  return (
    <div className="px-4 pb-16 pt-3" data-testid="vc-board">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} data-testid="vc-search"
          placeholder="Firm, partner or focus"
          className="min-w-[220px] flex-1 rounded-lg border px-3 py-2 text-[13.5px]"
          style={{ borderColor: "#E0E7E2", background: "#fff" }} />
        <Chip on={warmOnly} onClick={() => setWarmOnly((v) => !v)} tone="#B4531A">Warm only</Chip>
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-2" data-testid="vc-fit">
        <span className="w-11 text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: "#8C9E93" }}>Fit</span>
        <Chip on={fit === "all"} onClick={() => setFit("all")}>All <b>{countBy("fit", "all")}</b></Chip>
        {(["A", "B", "C", "D"] as const).map((g) => (
          <Chip key={g} on={fit === g} onClick={() => setFit(g)} tone={FIT_HUE[g].bg}>{g} <b>{countBy("fit", g)}</b></Chip>
        ))}
      </div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2" data-testid="vc-wave">
        <span className="w-11 text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: "#8C9E93" }}>Wave</span>
        <Chip on={wv === "all"} onClick={() => setWv("all")}>All <b>{countBy("wave", "all")}</b></Chip>
        {waveOptions.map((w) => <Chip key={w} on={wv === w} onClick={() => setWv(w)}>{w} <b>{countBy("wave", w)}</b></Chip>)}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="vc-owner">
        <span className="w-11 text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: "#8C9E93" }}>Owner</span>
        <Chip on={own === "all"} onClick={() => setOwn("all")}>All <b>{countBy("owner", "all")}</b></Chip>
        {ownerOptions.map((o) => <Chip key={o} on={own === o} onClick={() => setOwn(o)}>{o} <b>{countBy("owner", o)}</b></Chip>)}
        <Chip on={own === "__none"} onClick={() => setOwn("__none")}>Unowned <b>{countBy("owner", "__none")}</b></Chip>
      </div>

      {loading ? (
        <p className="py-10 text-center text-[13px]" style={{ color: "#8C9E93" }}>Loading…</p>
      ) : (
        <div className="flex items-start gap-2 overflow-x-auto pb-2" data-testid="vc-columns">
          {VC_OUTREACH_STAGES.map((st) => {
            const raw = cards.filter((c) => c.stage === st.id).length;
            const list = byStage(st.id);
            const shut = isCollapsed(st.id, raw);
            return shut ? (
              <button key={st.id} type="button" data-testid="vc-col" data-stage={st.id} data-collapsed="1"
                onClick={() => toggle(st.id, raw)}
                onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== st.id) setDragOverStage(st.id); }}
                onDrop={(e) => { e.preventDefault(); const id = draggingId.current; draggingId.current = null; setDragOverStage(null); if (id) void moveCardToStage(id, st.id); }}
                className="flex h-[420px] w-12 flex-none flex-col items-center gap-2 rounded-xl border pt-3"
                style={{ borderColor: dragOverStage === st.id ? "#35C77F" : "#E0E7E2", background: "#F7FAF8" }}>
                <span className="text-[12px] font-black" style={{ color: "#0F3323" }}>{list.length}</span>
                <span className="whitespace-nowrap text-[11px] font-bold tracking-wide"
                  style={{ writingMode: "vertical-rl", color: "#5C6F66" }}>{st.title}</span>
              </button>
            ) : (
              <div key={st.id} data-testid="vc-col" data-stage={st.id} data-collapsed="0"
                onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== st.id) setDragOverStage(st.id); }}
                onDrop={(e) => { e.preventDefault(); const id = draggingId.current; draggingId.current = null; setDragOverStage(null); if (id) void moveCardToStage(id, st.id); }}
                className="flex w-[298px] flex-none flex-col rounded-xl border"
                style={{ borderColor: dragOverStage === st.id ? "#35C77F" : "#E0E7E2", background: "#F7FAF8" }}>
                <button type="button" onClick={() => toggle(st.id, raw)}
                  className="flex items-center gap-2 px-3 py-2.5 text-left">
                  <span className="text-[11.5px] font-extrabold uppercase tracking-wider" style={{ color: "#0F3323" }}>{st.title}</span>
                  <span className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-black"
                    style={{ background: "#E7EEEA", color: "#3C4F44" }}>{list.length}</span>
                </button>
                <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {list.map((c) => <VcCard key={c.id} card={c}
                    onDragStart={() => { draggingId.current = c.id; }}
                    onClick={() => setModal({ mode: "edit", card: c })} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-[13px] text-white"
          style={{ background: "#8A2A1B" }} onAnimationEnd={() => setToast(null)} data-testid="vc-toast">{toast}</div>
      )}
      {/* THE SHARED MODAL, UNCHANGED. It takes the api and drives its own writes — the board does
          not wrap them. existingMarkets is Field Pipeline's city list and is empty here. */}
      {modal && (
        <KanbanCardModal boardType="vc_outreach" state={modal} api={api}
          existingMarkets={[]} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function VcCard({ card, onDragStart, onClick }: { card: KanbanCard; onDragStart: () => void; onClick: () => void }) {
  const g = vcFitGrade(String((card.data as Record<string, unknown>).fit_raw ?? ""));
  const hue = g ? FIT_HUE[g] : { bg: "#E7EEEA", fg: "#5C6F66" };
  const os = owners(card);
  const first = contacts(card)[0];
  return (
    <article draggable onDragStart={onDragStart} onClick={onClick} data-testid="vc-card" data-id={card.id}
      className="cursor-pointer rounded-lg border bg-white p-2.5 transition hover:shadow-sm"
      style={{ borderColor: "#E0E7E2" }}>
      <div className="flex items-start gap-2">
        <span data-testid="vc-fit-badge" className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md text-[17px] font-black leading-none"
          style={{ background: hue.bg, color: hue.fg }}>{g || "–"}</span>
        <b className="min-w-0 flex-1 break-words text-[13px] font-bold leading-snug" style={{ color: "#10231A" }}>{card.title}</b>
        {wave(card) && (
          <span className="flex-none rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "#EEF3F0", color: "#5C6F66" }}>{wave(card)}</span>
        )}
      </div>
      {/* TWO LINES, CLAMPED. These run to 231 characters; a card cannot carry that, and the full
          text is one click away in the modal. A SHORT ONE DOES NOT PAD — line-clamp is a maximum. */}
      {focus(card) && (
        <p data-testid="vc-focus" className="mt-1.5 overflow-hidden text-[11.5px] leading-[1.45]"
          style={{ color: "#5C6F66", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{focus(card)}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: first?.name ? "#3C4F44" : "#9AA8A1" }}>
          {first?.name ? first.name : <i>no contact named</i>}
        </span>
        {/* ONLY WHEN WARM. 73 of 90 are "No" — a chip on three quarters of the board is noise. */}
        {warm(card) && <span data-testid="vc-warm" className="flex-none rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "#FDEBDC", color: "#8A4A12" }}>warm</span>}
        {/* AN UNOWNED CARD SHOWS A DASHED PLACEHOLDER, not a blank. 50 of 90 have no owner,
            including three grade-A firms — the gap is the point and should be visible. */}
        {os.length ? (
          <span className="flex flex-none -space-x-1.5">
            {os.map((o) => (
              <span key={o} title={o} data-testid="vc-owner-av"
                className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black text-white ring-2 ring-white"
                style={{ background: hueFor(o) }}>{initials(o)}</span>
            ))}
          </span>
        ) : (
          <span data-testid="vc-unowned" className="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-dashed text-[10px]"
            style={{ borderColor: "#B9C6BE", color: "#B9C6BE" }}>?</span>
        )}
      </div>
    </article>
  );
}
