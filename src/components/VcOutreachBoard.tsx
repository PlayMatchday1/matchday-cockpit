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
  ageBand, stageAge, vcDueChip, vcFocusCategory, vcFundFocus, vcNextStepDue,
  type ChecklistItem, type KanbanCard, type KanbanOwner,
} from "@/lib/kanban";

const COLLAPSE_KEY = "vcoutreach:collapsed:v1";
const ACTIONS_KEY = "vcoutreach:actions:v1";

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
const focus = (c: KanbanCard) => vcFundFocus(c);
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

  /* ── ACTIONS: HIDDEN BY DEFAULT, AND THAT DIFFERS FROM FIELD PIPELINE ON PURPOSE ─────────────
   * Field Pipeline shows its to-dos by default and should keep doing so — it is a smaller board.
   * Measured here: a card with three open actions is 180.8px against 108.3px, which takes a 620px
   * column from 5 firms to 4. With ninety firms the board's first job is to be scannable, so it
   * opens as a list of firms carrying "3 open" chips and the toggle is how you switch to working.
   * Remembered per browser, like the collapse state. */
  const [showActions, setShowActions] = useState<boolean>(() => readLS(ACTIONS_KEY, false));
  const [actionsOnly, setActionsOnly] = useState(false);
  const [collapsedStored, setCollapsedStored] = useState<Record<string, boolean>>(() => readLS(COLLAPSE_KEY, {}));
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "edit"; card: KanbanCard } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const draggingId = useRef<string | null>(null);

  /* OPEN ACTIONS PER CARD, from the same checklists map the modal edits — so a tick in the modal
   * and the chip on the card cannot disagree. OPEN, never total: "0 actions" is not a state anybody
   * is chasing, and a firm whose actions are all done earns a tick instead of a number. */
  const openActions = useCallback((c: KanbanCard) => (api.checklists[c.id] ?? []).filter((i) => !i.done).length, [api.checklists]);
  const totalActions = useCallback((c: KanbanCard) => (api.checklists[c.id] ?? []).length, [api.checklists]);
  const openActionsTotal = useMemo(
    () => cards.reduce((n, c) => n + openActions(c), 0), [cards, openActions]);

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
    if (actionsOnly && openActions(c) === 0) return false;
    return true;
  }, [q, fit, wv, own, warmOnly, actionsOnly, openActions]);

  const shown = useMemo(() => cards.filter(matches), [cards, matches]);
  const byStage = useCallback((id: string) => shown.filter((c) => c.stage === id), [shown]);

  /* COUNTS COMPOSE, each axis counting against everything except itself — the rule the Field
   * Pipeline chips and the Applications chips both follow. A chip promising 21 that yields 3 is
   * worse than a chip with no number. */
  const countBy = useCallback((axis: "fit" | "wave" | "owner", value: string) => cards.filter((c) => {
    const needle = q.trim().toLowerCase();
    if (needle && ![c.title, focus(c), ...contacts(c).map((x) => x.name ?? "")].join(" ").toLowerCase().includes(needle)) return false;
    if (warmOnly && !warm(c)) return false;
    // The actions filter composes like every other axis: with it off, every count is what it was.
    if (actionsOnly && openActions(c) === 0) return false;
    if (axis !== "fit" && fit !== "all" && grade(c) !== fit) return false;
    if (axis !== "wave" && wv !== "all" && wave(c) !== wv) return false;
    if (axis !== "owner" && own !== "all" && !(own === "__none" ? owners(c).length === 0 : owners(c).includes(own))) return false;
    if (value === "all") return true;
    if (axis === "fit") return grade(c) === value;
    if (axis === "wave") return wave(c) === value;
    return value === "__none" ? owners(c).length === 0 : owners(c).includes(value);
  }).length, [cards, q, warmOnly, fit, wv, own, actionsOnly, openActions]);

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

  /* WHO AN ACTION IS ASSIGNED TO, resolved from the app_users the api already loaded — the same
   * initial-plus-name treatment Field Pipeline gives an assignee, one step quieter than the card's
   * own owner avatars. */
  const assigneeFor = useCallback((item: ChecklistItem): { name: string; initials: string } | null => {
    if (!item.owner_user_id) return null;
    const o: KanbanOwner | undefined = api.owners.find((x) => x.id === item.owner_user_id);
    if (!o) return null;
    const name = o.full_name?.trim() || o.email.split("@")[0];
    return { name, initials: initials(name) || name.slice(0, 2).toUpperCase() };
  }, [api.owners]);

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
        {/* SHOWN OR HIDDEN, remembered per browser. See the state's own note for the default. */}
        <button type="button" data-testid="vc-actions-toggle" aria-pressed={showActions}
          onClick={() => { setShowActions((v) => { writeLS(ACTIONS_KEY, !v); return !v; }); }}
          className="rounded-lg border px-3 py-1.5 text-[12px] font-bold transition"
          style={showActions
            ? { background: "#0F3323", borderColor: "#0F3323", color: "#fff" }
            : { background: "#fff", borderColor: "#E0E7E2", color: "#0F3323" }}>
          {showActions ? "Actions shown" : "Actions hidden"}
        </button>
        {/* THE MOST USEFUL CONTROL ON FIELD PIPELINE, PORTED: the number, and pressing it narrows
            the board to the firms that have work. Absent when nothing is open, because a zero here
            is not something anybody is chasing. */}
        {openActionsTotal > 0 && (
          <button type="button" data-testid="vc-actions-filter" aria-pressed={actionsOnly}
            onClick={() => setActionsOnly((v) => !v)}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition"
            style={actionsOnly
              ? { background: "#BFE4CF", borderColor: "#8FCBAA", color: "#12704A" }
              : { background: "#E0F2E7", borderColor: "#C9E8D8", color: "#12704A" }}>
            <b className="font-extrabold">{openActionsTotal}</b> open {openActionsTotal === 1 ? "action" : "actions"}
          </button>
        )}
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
                    checklist={api.checklists[c.id] ?? []}
                    showActions={showActions}
                    assigneeFor={assigneeFor}
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

/* THE META ROW'S CHIP STYLES, one per kind, and `late` / `warn` / `crit` change the GROUND and not
 * just the words — a date that reads "3d overdue" in the same grey as "due Sep 12" is a date nobody
 * sees. */
const META: Record<string, { bg: string; fg: string }> = {
  cat: { bg: "#E8EFEA", fg: "#3F5B4E" },
  due: { bg: "#EDF3FA", fg: "#2C5480" },
  dueLate: { bg: "#FDE7E3", fg: "#A8341F" },
  act: { bg: "#F1F4F2", fg: "#5C6F66" },
  actDone: { bg: "#EAF4EE", fg: "#1F7A4D" },
  age: { bg: "#F1F4F2", fg: "#5C6F66" },
  ageWarn: { bg: "#FBF0DC", fg: "#8A5A12" },
  ageCrit: { bg: "#FDE7E3", fg: "#A8341F" },
};

function VcCard({ card, checklist, showActions, assigneeFor, onDragStart, onClick }: {
  card: KanbanCard;
  checklist: ChecklistItem[];
  showActions: boolean;
  assigneeFor: (i: ChecklistItem) => { name: string; initials: string } | null;
  onDragStart: () => void;
  onClick: () => void;
}) {
  const g = vcFitGrade(String((card.data as Record<string, unknown>).fit_raw ?? ""));
  const hue = g ? FIT_HUE[g] : { bg: "#E7EEEA", fg: "#5C6F66" };
  const os = owners(card);
  const first = contacts(card)[0];

  /* ── EVERY CHIP COMES FROM A FIELD THE MODAL OWNS, AND ONLY WHAT APPLIES RENDERS ─────────────
   * No placeholders and no empty row: a firm with no category, no due date and no actions is
   * today's card minus the blurb, which on day one is most of the board. */
  const cat = vcFocusCategory(vcFundFocus(card));
  const due = vcDueChip(vcNextStepDue(card));
  const open = checklist.filter((i) => !i.done);
  const age = stageAge(card, Date.now(), "vc_outreach");
  const band = age ? ageBand(age.days, "vc_outreach") : null;
  const chips: { key: string; tone: { bg: string; fg: string }; text: string }[] = [];
  if (cat) chips.push({ key: "cat", tone: META.cat, text: cat });
  if (due) chips.push({ key: "due", tone: due.late ? META.dueLate : META.due, text: due.label });
  // OPEN, NOT TOTAL. A firm whose actions are all ticked earns the tick; a firm with none says
  // nothing at all.
  if (checklist.length > 0) {
    chips.push(open.length > 0
      ? { key: "act", tone: META.act, text: `${open.length} open` }
      : { key: "act", tone: META.actDone, text: "✓ done" });
  }
  // "≥ Nd" WHEN THE SOURCE IS A LOWER BOUND — the existing convention, not dropped quietly.
  if (age) chips.push({
    key: "age",
    tone: band === "crit" ? META.ageCrit : band === "warn" ? META.ageWarn : META.age,
    text: `${age.exact ? "" : "≥ "}${age.days}d`,
  });
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
      {/* THE BLURB IS GONE FROM THE CARD AND IS NOW A FIELD IN THE MODAL. It was two clamped lines
          of up to 231 characters, and the comment here used to say the full text was one click away
          — it was not, because the modal had no field for it. It does now (Fund focus), so the
          claim is true and the space carries the state instead. What the trade actually bought is
          in the report: not more firms per screen, the same number carrying what you act on. */}
      {chips.length > 0 && (
        <div data-testid="vc-meta" className="mt-1.5 flex flex-wrap items-center gap-[5px]">
          {chips.map((c) => (
            <span key={c.key} data-testid={`vc-meta-${c.key}`}
              className="inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold"
              style={{ background: c.tone.bg, color: c.tone.fg }}>{c.text}</span>
          ))}
        </div>
      )}
      {/* ── THE OPEN ACTIONS THEMSELVES, Field Pipeline's treatment ported rather than reinvented:
             a hairline rule, an empty 13px box, the text truncated with a title, and the assignee to
             the right one step quieter than the card's owner. A TICKED ACTION NEVER RENDERS — the
             card is the outstanding work, not the history — and a card with none shows no divider
             and no empty element. */}
      {showActions && open.length > 0 && (
        <div data-testid="vc-card-actions" className="mt-2 flex flex-col gap-[5px] border-t pt-[7px]" style={{ borderColor: "#EFF3F1" }}>
          {open.map((i) => {
            const a = assigneeFor(i);
            return (
              <div key={i.id} data-testid="vc-card-action" className="flex items-center gap-[7px] text-[11.5px] leading-[1.35]" style={{ color: "#3A4D44" }}>
                <span className="h-[13px] w-[13px] flex-none rounded border-[1.5px]" style={{ borderColor: "#B9C6BF", background: "#fff" }} />
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={i.text}>{i.text}</span>
                {a ? (
                  <span className="flex flex-none items-center gap-[4px]" title={a.name}>
                    <span className="flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full border text-[8px] font-bold"
                      style={{ background: "#EEF3F0", borderColor: "#E2EAE5", color: "#46584F" }}>{a.initials}</span>
                    <span className="whitespace-nowrap text-[10.5px]" style={{ color: "#626F68" }}>{a.name}</span>
                  </span>
                ) : (
                  <span className="flex-none text-[10.5px] italic" style={{ color: "#626F68" }}>Unassigned</span>
                )}
              </div>
            );
          })}
        </div>
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
