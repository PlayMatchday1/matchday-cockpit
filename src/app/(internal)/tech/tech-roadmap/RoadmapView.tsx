"use client";

// Tech Roadmap — App Roadmap + Clubhouse Roadmap, one component, two boards
// (mockup docs/mockups/roadmap-v1_3.html). Every number on the page is DERIVED
// from the loaded cards (src/lib/roadmap.ts); there is no typed-in figure. The
// board reads/writes kanban_cards through the shared useKanbanBoard hook (same
// path Field Pipeline uses); a move writes the new stage and the DB trigger
// stamps stage_entered_at = now(), which is the board's stale clock. Mutations
// are gated on app_users.is_admin — a non-admin gets a read-only board.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { useKanbanBoard } from "@/lib/useKanbanBoard";
import {
  cardEstimatedHours, cardOwnerLabel, cardPriority, firstName, ownerName,
  type KanbanCard, type KanbanOwner, type RoadmapBoard,
} from "@/lib/kanban";
import {
  ROADMAP_COLS, STALE_ACTIVE_DAYS, STALE_IDEA_DAYS, FRESH_WINDOW_DAYS,
  daysInColumn, movedAtMs, createdAtMs, daysSince, dfull, staleLimitFor,
  isStale, isFresh, wantsEstimate, columnMetaLine, deriveStateBar, plural,
} from "@/lib/roadmap";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7",
  amount: "#e2502b", ink: "#12241d", muted: "#6d7b74", muted2: "#9aa8a1",
  warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railA: "#fafbfa", railB: "#f6f9f7", board: "#f8faf9",
  chipBg: "#eef3f0", chipLine: "#e2eae5", line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff",
};
const PRI_STRIPE: Record<string, string> = { High: "#d9603c", Medium: C.warnLine, Low: "#b9c7c0" };

const BOARDS: Record<RoadmapBoard, { name: string; sub: string }> = {
  app: { name: "App Roadmap", sub: "What is being built for the player app, from idea to shipped." },
  clubhouse: { name: "Clubhouse Roadmap", sub: "What is being built for Clubhouse itself — the internal tools MatchDay Ops runs on." },
};

const boardOf = (c: KanbanCard): RoadmapBoard => (c.board === "clubhouse" ? "clubhouse" : "app");

// `board` comes from the URL (/tech/tech-roadmap/app|clubhouse) — the section
// sidebar is the single roadmap picker now; this component has no rail.
export default function RoadmapView({ board }: { board: RoadmapBoard }) {
  const { appUser } = useAuth();
  const isAdmin = !!appUser?.is_admin;
  const api = useKanbanBoard("tech_roadmap");
  const { cards, owners, loading, error } = api;

  const [q, setQ] = useState("");
  const [ownerF, setOwnerF] = useState(""); // "" | "__none" | ownerId
  const [priF, setPriF] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // A single clock for the whole render so every age is consistent.
  const nowMs = useMemo(() => Date.now(), [cards]);
  const ownersById = useMemo(() => new Map(owners.map((o) => [o.id, o])), [owners]);

  const boardCards = useMemo(() => cards.filter((c) => boardOf(c) === board), [cards, board]);

  // The state bar is a fact about the BOARD, not the filter — derived from all
  // board cards, never the filtered subset.
  const bar = useMemo(() => deriveStateBar(boardCards, nowMs), [boardCards, nowMs]);

  const ownerLabelOf = useCallback((c: KanbanCard): string => {
    if (c.owner_user_id) { const o = ownersById.get(c.owner_user_id); if (o) return firstName(ownerName(o)); }
    const l = cardOwnerLabel(c); return l ? firstName(l) : "";
  }, [ownersById]);

  const passes = useCallback((c: KanbanCard): boolean => {
    if (q && !c.title.toLowerCase().includes(q.toLowerCase())) return false;
    if (ownerF === "__none") { if (c.owner_user_id) return false; }
    else if (ownerF && c.owner_user_id !== ownerF) return false;
    if (priF && cardPriority(c) !== priF) return false;
    if (staleOnly && !isStale(c, nowMs)) return false;
    return true;
  }, [q, ownerF, priF, staleOnly, nowMs]);

  const filtering = !!(q || ownerF || priF || staleOnly);
  const sel = selId ? cards.find((c) => c.id === selId) ?? null : null;

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of boardCards) if (c.owner_user_id) {
      const o = ownersById.get(c.owner_user_id);
      if (o) seen.set(o.id, ownerName(o));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [boardCards, ownersById]);
  const anyNoOwner = useMemo(() => boardCards.some((c) => !c.owner_user_id), [boardCards]);

  // ── move: only write when the column actually changes; stamp the clock ──
  const moveCard = useCallback(async (id: string, toStage: string) => {
    if (!isAdmin) return;
    const card = cards.find((c) => c.id === id);
    if (!card || card.stage === toStage) return;
    const maxOrder = cards.filter((c) => boardOf(c) === boardOf(card) && c.stage === toStage)
      .reduce((m, c) => Math.max(m, c.sort_order), 0);
    // stage_entered_at is authoritatively reset by the DB trigger; we also set it
    // locally so the age updates immediately without waiting for a reload.
    await api.updateCard(id, { stage: toStage, sort_order: maxOrder + 1, stage_entered_at: new Date().toISOString() });
  }, [isAdmin, cards, api]);

  const clearFilters = () => { setQ(""); setOwnerF(""); setPriF(""); setStaleOnly(false); };

  if (loading && cards.length === 0) return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading roadmap…</div>;

  const b = BOARDS[board];

  return (
    <div className="min-w-0" style={{ color: C.ink }}>
      <style>{`
        .rm-clist::-webkit-scrollbar{width:8px}
        .rm-clist::-webkit-scrollbar-thumb{background:#d7e0db;border-radius:8px}
      `}</style>

      {error && <div className="mb-3 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: C.critLine, background: C.critBg, color: C.critInk }}>Write failed: {error}</div>}

      {/* One rail only: the Tech section sidebar picks the board (see
          tech/layout.tsx). The board takes the full width here. */}
      <div className="mb-3.5 flex items-start gap-3.5">
            <div>
              <h1 className="m-0 mb-0.5 text-[23px] font-[800] tracking-[-0.015em]" style={{ color: C.forestDeep }}>{b.name}</h1>
              <p className="m-0 text-[12.5px]" style={{ color: C.muted }}>{b.sub}</p>
            </div>
            {isAdmin && (
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => setCreating(true)} className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[9px] border px-[13px] text-[12.5px] font-bold" style={{ background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" }}>+ New card</button>
              </div>
            )}
          </div>

          {/* state bar */}
          <StateBar bar={bar} staleOnly={staleOnly} onShowStuck={() => setStaleOnly(true)} />

          {/* filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input data-testid="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles…"
              className="min-h-[34px] min-w-[180px] flex-1 rounded-[9px] border px-[11px] text-[12.5px]" style={{ borderColor: C.chipLine, background: C.surface }} />
            <select data-testid="owner-filter" value={ownerF} onChange={(e) => setOwnerF(e.target.value)} className="min-h-[34px] rounded-[9px] border px-[11px] text-[12.5px]" style={{ borderColor: C.chipLine, background: C.surface }}>
              <option value="">All owners</option>
              {ownerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              {anyNoOwner && <option value="__none">No owner</option>}
            </select>
            <select data-testid="priority-filter" value={priF} onChange={(e) => setPriF(e.target.value)} className="min-h-[34px] rounded-[9px] border px-[11px] text-[12.5px]" style={{ borderColor: C.chipLine, background: C.surface }}>
              <option value="">All priorities</option><option>High</option><option>Medium</option><option>Low</option>
            </select>
            <button type="button" data-testid="stuck-toggle" onClick={() => setStaleOnly((v) => !v)}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[9px] border px-3 text-[12.5px] font-bold"
              style={staleOnly ? { background: C.warnBg, borderColor: C.warnLine, color: C.warnInk } : { background: C.surface, borderColor: C.chipLine, color: C.muted }}>
              {staleOnly ? "Showing only what is stuck" : "Only what is stuck"}
              <span className="rounded-[8px] px-1.5 text-[11px]" style={{ background: "rgba(0,0,0,.06)" }}>{bar.stale}</span>
            </button>
            {filtering && <button type="button" data-testid="clear-filters" onClick={clearFilters} className="ml-auto inline-flex min-h-[34px] items-center rounded-[9px] border px-3 text-[12.5px] font-bold" style={{ background: C.surface, borderColor: C.chipLine, color: C.forest }}>Clear filters</button>}
          </div>

          {/* board */}
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="board">
            {ROADMAP_COLS.map((col) => {
              const total = boardCards.filter((c) => c.stage === col.id);
              const vis = total.filter(passes);
              const meta = columnMetaLine(col.id, total, nowMs);
              // FIXED height (h-, not max-h): all four columns run to the same
              // bottom edge and each scrolls independently, so a 2-card column
              // shows empty space, not a short box — no ragged bottom.
              return (
                <div key={col.id} data-col={col.id} onDragOver={(e) => { if (isAdmin && dragId.current) { e.preventDefault(); setDragOver(col.id); } }}
                  onDragLeave={() => setDragOver((d) => (d === col.id ? null : d))}
                  onDrop={(e) => { e.preventDefault(); const id = dragId.current; dragId.current = null; setDragOver(null); if (id) void moveCard(id, col.id); }}
                  className="flex h-[min(66vh,700px)] flex-col overflow-hidden rounded-[12px] border" style={{ background: C.board, borderColor: dragOver === col.id ? C.accent : C.line }}>
                  <div className="flex flex-none items-center gap-2 border-b px-3 pb-2.5 pt-2.5" style={{ background: C.surface, borderColor: C.line }}>
                    <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-[800] text-white" style={{ background: C.forestDeep }}>{ROADMAP_COLS.indexOf(col) + 1}</span>
                    <span className="min-w-0 truncate text-[13px] font-[800]" style={{ color: C.forestDeep }}>{col.title}</span>
                    <span data-testid={`colcount-${col.id}`} className="ml-auto flex-none rounded-[9px] border px-[7px] py-px text-[11px] font-[800]" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>
                      {vis.length}{vis.length !== total.length ? ` of ${total.length}` : ""}
                    </span>
                  </div>
                  {meta && <div className="flex-none border-b px-3 pb-2.5 text-[10.5px] font-semibold leading-[1.4]" style={{ background: C.surface, borderColor: C.line, color: C.muted }} data-testid={`colmeta-${col.id}`}>{meta}</div>}
                  <div className="rm-clist flex flex-1 flex-col gap-2 overflow-y-auto p-[9px]">
                    {vis.length === 0
                      ? <div className="px-3 py-4 text-center text-[12px]" style={{ color: C.muted }}>{total.length ? "No card here matches the filters." : `Nothing in ${col.title.toLowerCase()}.`}</div>
                      : vis.map((c) => <Card key={c.id} c={c} nowMs={nowMs} owner={ownerLabelOf(c)} selected={selId === c.id} draggable={isAdmin}
                          onOpen={() => setSelId(c.id)}
                          onDragStart={() => { dragId.current = c.id; }} onDragEnd={() => { dragId.current = null; setDragOver(null); }} />)}
                  </div>
                </div>
              );
            })}
          </div>

      <Footer cards={boardCards} nowMs={nowMs} boardName={b.name} />

      {sel && <Drawer card={sel} nowMs={nowMs} boardName={BOARDS[boardOf(sel)].name} owner={sel.owner_user_id ? ownerName(ownersById.get(sel.owner_user_id)) : cardOwnerLabel(sel)}
        isAdmin={isAdmin} owners={owners}
        onClose={() => setSelId(null)}
        onMove={(to) => moveCard(sel.id, to)}
        onPatch={(patch) => isAdmin && api.updateCard(sel.id, patch)}
        onDelete={async () => { if (isAdmin) { await api.deleteCard(sel.id); setSelId(null); } }} />}

      {creating && isAdmin && <CreateModal board={board} owners={owners} onClose={() => setCreating(false)}
        onCreate={async (input) => { await api.createCard({ ...input, board }); setCreating(false); }} />}
    </div>
  );
}

// ── state bar ──────────────────────────────────────────────────────────────
function StateBar({ bar, staleOnly, onShowStuck }: { bar: ReturnType<typeof deriveStateBar>; staleOnly: boolean; onShowStuck: () => void }) {
  return (
    <div data-testid="statebar" className="mb-3 flex max-h-[130px] flex-col gap-[9px] rounded-[12px] border p-[11px_15px]" style={{ background: C.surface, borderColor: C.line }}>
      <div className="flex flex-wrap items-center gap-0">
        <Stat><b data-stat="total">{bar.total}</b><u>{plural(bar.total, "card")} on this board</u></Stat>
        <Stat><b data-stat="inprogress">{bar.inProgress}</b><u>in progress</u></Stat>
        <Stat><b data-stat="fresh">{bar.fresh}</b><u>changed in {FRESH_WINDOW_DAYS} days</u></Stat>
        <Stat>
          <b data-stat="stale" style={{ color: bar.stale ? C.warnInk : C.forestDeep }}>{bar.stale}</b>
          {bar.stale && !staleOnly
            ? <button data-testid="stuck-affordance" data-kind="button" onClick={onShowStuck} className="border-0 bg-transparent p-0 text-left text-[11px] font-[800] underline underline-offset-2" style={{ color: C.forest }}>sitting too long — show only these</button>
            : <u data-testid="stuck-affordance" data-kind="text">sitting too long{staleOnly && bar.stale ? " — showing these" : ""}</u>}
        </Stat>
      </div>
      {/* fix 5: the estimate sentence is its own full-width, LEFT-aligned row —
          not right-aligned beside the stats, where it wrapped with "show" alone
          on the last line. text-wrap:pretty forbids that orphaned last line. */}
      <div data-testid="estrow" className="w-full border-t pt-[9px] text-left text-[11px] font-semibold leading-[1.4] no-underline" style={{ borderColor: C.hair, color: C.muted, textWrap: "pretty" }}>
        {bar.withEstimate > 0 ? (
          <><b data-stat="esthours" style={{ color: C.forestDeep }}>{bar.estimatedHours}h</b> estimated across the {plural(bar.withEstimate, "card")} that carr{bar.withEstimate === 1 ? "ies" : "y"} an estimate · {bar.noEstimate} carr{bar.noEstimate === 1 ? "ies" : "y"} none, so this is not the board&rsquo;s total</>
        ) : (
          <span data-stat="esthours" data-none="1">no card carries an estimate yet, so there is no board total to show</span>
        )}
      </div>
    </div>
  );
}
function Stat({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-px border-l px-[17px] first:border-l-0 first:pl-0 [&>b]:text-[16px] [&>b]:font-[800] [&>b]:leading-[1.15] [&>u]:text-[10.5px] [&>u]:font-[800] [&>u]:not-italic [&>u]:uppercase [&>u]:tracking-[0.06em] [&>u]:no-underline" style={{ borderColor: C.hair, color: C.muted }}>{children}</div>;
}

// ── card ───────────────────────────────────────────────────────────────────
function Card({ c, nowMs, owner, selected, draggable, onOpen, onDragStart, onDragEnd }: {
  c: KanbanCard; nowMs: number; owner: string; selected: boolean; draggable: boolean;
  onOpen: () => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const pri = cardPriority(c);
  const est = cardEstimatedHours(c);
  const stale = isStale(c, nowMs);
  const isIdea = c.stage === "ideas";
  const days = daysInColumn(c, nowMs);
  // meta bits: priority always; an age/date on every card EXCEPT ideas; est if present.
  const bits: string[] = [];
  if (pri) bits.push(pri);
  if (c.stage === "shipped") bits.push(`shipped ${dfull(movedAtMs(c))}`);
  else if (!isIdea) bits.push(days === 0 ? "moved today" : `moved ${days}d ago`);
  if (est !== null) bits.push(`${est}h`);

  return (
    // Discovery is on the card, not in a tooltip: a hover title tells you
    // nothing until you've already guessed the card is clickable (and it drew on
    // top of the neighbour's meta row, hiding it). A muted "Details ›" marker
    // sits in the corner of EVERY card, visible whether or not the pointer is
    // near — aria-hidden because the whole card is already a labelled button.
    <div data-testid="card" data-card-id={c.id} data-stage={c.stage} data-idea={isIdea ? "1" : "0"}
      draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={onOpen} role="button" tabIndex={0} aria-label={`Open ${c.title}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="relative flex-none cursor-pointer overflow-hidden rounded-[10px] border pl-[11px] pr-[10px] pt-[9px] pb-2"
      style={{ background: C.surface, borderColor: selected ? C.accent : C.line, boxShadow: selected ? `0 0 0 2px rgba(53,199,127,.22)` : "0 1px 1px rgba(13,59,46,.03)" }}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: pri ? PRI_STRIPE[pri] : C.chipLine }} />
      <div className="flex items-start gap-2 text-[12.5px] font-[800] leading-[1.3]" style={{ color: C.forestDeep }}>
        <span className="min-w-0 flex-1">{c.title}</span>
        <em data-testid="card-owner" className="max-w-[86px] flex-none truncate rounded-[7px] border px-[6px] py-px text-[10.5px] font-[800] not-italic"
          style={owner ? { background: C.chipBg, borderColor: C.chipLine, color: C.muted } : { background: C.critBg, borderColor: C.critLine, color: C.critInk }}>{owner || "No owner"}</em>
        <span data-testid="card-details" aria-hidden className="flex-none whitespace-nowrap pt-px text-[10px] font-[800] not-italic" style={{ color: C.muted2 }}>Details ›</span>
      </div>
      <div data-testid="card-meta" className="mt-[5px] flex flex-wrap items-center gap-x-[7px] gap-y-1 text-[10.5px] font-semibold" style={{ color: C.muted }}>
        {bits.map((bt, i) => <span key={i} className="flex items-center gap-[7px]">{i > 0 && <i className="not-italic opacity-50">·</i>}<i className="not-italic">{bt}</i></span>)}
        {/* stuck chip carries NO number — the meta line already says how long. Never on an idea. */}
        {stale && !isIdea && <em data-testid="chip-stuck" className="rounded-[7px] border px-[6px] py-px text-[10px] font-[800] not-italic" style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>stuck</em>}
        {wantsEstimate(c) && <em data-testid="chip-noest" className="rounded-[7px] border px-[6px] py-px text-[10px] font-[800] not-italic" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>no estimate</em>}
      </div>
    </div>
  );
}

// ── drawer ─────────────────────────────────────────────────────────────────
function Drawer({ card, nowMs, boardName, owner, isAdmin, owners, onClose, onMove, onPatch, onDelete }: {
  card: KanbanCard; nowMs: number; boardName: string; owner: string; isAdmin: boolean; owners: KanbanOwner[];
  onClose: () => void; onMove: (to: string) => void; onPatch: (patch: { owner_user_id?: string | null; data?: Record<string, unknown> }) => void; onDelete: () => void;
}) {
  const stale = isStale(card, nowMs);
  const limit = staleLimitFor(card.stage);
  const est = cardEstimatedHours(card);
  const colTitle = ROADMAP_COLS.find((x) => x.id === card.stage)?.title ?? card.stage;
  const desc = typeof card.data?.description === "string" ? card.data.description.trim() : "";
  const movedDays = daysInColumn(card, nowMs);
  const createdDays = daysSince(createdAtMs(card), nowMs);
  // "a card in the In plan column" — NOT "a card in ${lower}", which produced
  // the awkward "a card in in plan" doubling the eye pass caught.
  const note = card.stage === "shipped"
    ? "Shipped cards are never flagged — there is nothing left to chase."
    : stale
      ? `Flagged: nothing has happened to this card in ${plural(movedDays, "day")}, and a card in the ${colTitle} column is flagged past ${limit}.`
      : `Not flagged: a card in the ${colTitle} column is flagged once it goes ${limit} days without moving, and this one is at ${movedDays}.`;

  return (
    <>
      <div data-testid="scrim" onClick={onClose} className="fixed inset-0 z-[40]" style={{ background: "rgba(7,42,32,.28)" }} />
      <aside data-testid="drawer" className="fixed inset-y-0 right-0 z-[41] flex w-[392px] max-w-[94vw] flex-col border-l" style={{ background: C.surface, borderColor: C.line, boxShadow: "-6px 0 22px rgba(7,42,32,.13)" }}>
        <div className="flex items-start gap-2.5 border-b px-[17px] pb-3 pt-[15px]" style={{ borderColor: C.line }}>
          <div className="min-w-0">
            <h3 className="m-0 mb-1 text-[15.5px] leading-[1.3]" style={{ color: C.forestDeep }} data-testid="drawer-title">{card.title}</h3>
            <div className="text-[11.5px] font-bold" style={{ color: C.muted }}>{boardName} · {colTitle}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] border text-[15px]" style={{ borderColor: C.chipLine, color: C.muted }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-[17px] py-3.5">
          <Sec title="WHAT THIS IS">
            <div className="text-[12px] leading-[1.5]" style={{ color: desc ? C.ink : C.muted }}>
              {desc || "No description written. This card cannot be picked up without asking somebody — every card here that nobody wrote a line for has to be explained out loud in standup instead."}
            </div>
          </Sec>
          <Sec title="THE CARD">
            <Row label="Owner">{owner ? owner : <span style={{ color: C.critInk }}>Nobody — this card cannot be worked</span>}</Row>
            <Row label="Priority">{cardPriority(card) ?? "—"}</Row>
            <Row label="Estimate">{est !== null ? plural(est, "hour") : <span style={{ color: C.muted }}>None typed in{wantsEstimate(card) ? ` — a card in the ${colTitle} column should carry one` : ""}</span>}</Row>
            <Row label="Created">{dfull(createdAtMs(card))} · {plural(createdDays, "day")} ago</Row>
            <Row label={card.stage === "shipped" ? "Shipped" : "Last moved"}>{dfull(movedAtMs(card))} · {movedDays === 0 ? "today" : `${plural(movedDays, "day")} ago`}</Row>
          </Sec>
          <Sec title={`WHY IT IS ${stale ? "FLAGGED" : "NOT FLAGGED"}`}>
            <div data-testid="drawer-flag" className="text-[12px] leading-[1.5]" style={{ color: stale ? C.warnInk : C.muted }}>{note}</div>
          </Sec>
          {isAdmin && (
            <Sec title="MOVE IT">
              <div className="flex flex-wrap gap-1.5">
                {ROADMAP_COLS.map((x) => (
                  <button key={x.id} type="button" data-testid={`move-${x.id}`} disabled={x.id === card.stage} onClick={() => onMove(x.id)}
                    className="min-h-[30px] rounded-[8px] border px-2.5 text-[11.5px] font-bold disabled:cursor-default"
                    style={x.id === card.stage ? { background: C.mint, borderColor: "#bfe0cd", color: C.forestDeep } : { background: C.surface, borderColor: C.chipLine, color: C.forest }}>
                    {x.id === card.stage ? "Here now" : x.title}
                  </button>
                ))}
              </div>
              <div className="mt-[7px] text-[12px]" style={{ color: C.muted }}>Moving a card resets its stale clock. Dragging it between columns does the same thing.</div>
            </Sec>
          )}
          {isAdmin && <DrawerEdit card={card} owners={owners} onPatch={onPatch} onDelete={onDelete} />}
        </div>
      </aside>
    </>
  );
}
function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mb-4"><h4 className="m-0 mb-1.5 text-[10.5px] font-[800] tracking-[0.08em]" style={{ color: C.muted }}>{title}</h4>{children}</div>;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2.5 border-b py-[5px] text-[12.5px] last:border-b-0" style={{ borderColor: C.hair }}><b className="flex-none pt-px text-[11.5px] font-bold" style={{ width: 108, color: C.muted }}>{label}</b><span className="min-w-0 flex-1 font-semibold" style={{ color: C.ink }}>{children}</span></div>;
}

// Compact admin edit (owner / priority / estimate) + delete. The mockup drawer
// is read + move; owner and priority are the fields it calls out as problems
// ("No owner — cannot be worked"), so admins get a way to fix them here.
function DrawerEdit({ card, owners, onPatch, onDelete }: { card: KanbanCard; owners: KanbanOwner[]; onPatch: (patch: { owner_user_id?: string | null; data?: Record<string, unknown> }) => void; onDelete: () => void }) {
  const est = cardEstimatedHours(card);
  const [confirm, setConfirm] = useState(false);
  return (
    <Sec title="EDIT">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-[11.5px]" style={{ color: C.muted }}>
          <span className="w-[70px]">Owner</span>
          <select value={card.owner_user_id ?? ""} onChange={(e) => onPatch({ owner_user_id: e.target.value || null })} className="min-h-[30px] flex-1 rounded-[8px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }}>
            <option value="">No owner</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{ownerName(o)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11.5px]" style={{ color: C.muted }}>
          <span className="w-[70px]">Priority</span>
          <select value={cardPriority(card) ?? ""} onChange={(e) => onPatch({ data: { ...card.data, priority: e.target.value || null } })} className="min-h-[30px] flex-1 rounded-[8px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }}>
            <option value="">—</option><option>High</option><option>Medium</option><option>Low</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11.5px]" style={{ color: C.muted }}>
          <span className="w-[70px]">Estimate</span>
          <input defaultValue={est ?? ""} inputMode="numeric" placeholder="hours" onBlur={(e) => { const v = e.target.value.trim(); const n = v === "" ? null : Number(v); if (v === "" || (Number.isFinite(n) && (n as number) >= 0)) onPatch({ data: { ...card.data, estimated_hours: n } }); }} className="min-h-[30px] flex-1 rounded-[8px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
        </label>
        {confirm
          ? <div className="flex items-center gap-2 text-[11.5px]" style={{ color: C.critInk }}>Delete this card?<button type="button" onClick={onDelete} className="rounded-[7px] px-2 py-1 font-bold text-white" style={{ background: C.critInk }}>Delete</button><button type="button" onClick={() => setConfirm(false)} className="rounded-[7px] border px-2 py-1 font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Cancel</button></div>
          : <button type="button" onClick={() => setConfirm(true)} className="self-start text-[11.5px] font-bold underline" style={{ color: C.critInk }}>Delete card</button>}
      </div>
    </Sec>
  );
}

// ── create ─────────────────────────────────────────────────────────────────
function CreateModal({ board, owners, onClose, onCreate }: { board: RoadmapBoard; owners: KanbanOwner[]; onClose: () => void; onCreate: (input: { title: string; stage: string; owner_user_id: string | null; data: Record<string, unknown> }) => void }) {
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState("ideas");
  const [ownerId, setOwnerId] = useState("");
  const [pri, setPri] = useState("Medium");
  const [desc, setDesc] = useState("");
  const [est, setEst] = useState("");
  const save = () => {
    if (!title.trim()) return;
    const n = est.trim() === "" ? null : Number(est);
    onCreate({ title: title.trim(), stage, owner_user_id: ownerId || null, data: { priority: pri, description: desc.trim(), planned_date: null, ...(n !== null && Number.isFinite(n) ? { estimated_hours: n } : {}) } });
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(7,42,32,.4)" }} />
      <div className="relative w-full max-w-[440px] rounded-[16px] border p-5" style={{ background: C.surface, borderColor: C.line }}>
        <h2 className="m-0 mb-3 text-[16px] font-[800]" style={{ color: C.forestDeep }}>New card · {BOARDS[board].name}</h2>
        <div className="flex flex-col gap-2.5">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="min-h-[36px] rounded-[8px] border px-2.5 text-[13px]" style={{ borderColor: C.chipLine }} />
          <div className="flex gap-2">
            <select value={stage} onChange={(e) => setStage(e.target.value)} className="min-h-[36px] flex-1 rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.chipLine }}>{ROADMAP_COLS.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
            <select value={pri} onChange={(e) => setPri(e.target.value)} className="min-h-[36px] flex-1 rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.chipLine }}><option>High</option><option>Medium</option><option>Low</option></select>
          </div>
          <div className="flex gap-2">
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="min-h-[36px] flex-1 rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.chipLine }}><option value="">No owner</option>{owners.map((o) => <option key={o.id} value={o.id}>{ownerName(o)}</option>)}</select>
            <input value={est} onChange={(e) => setEst(e.target.value)} inputMode="numeric" placeholder="Estimate (h)" className="min-h-[36px] w-[130px] rounded-[8px] border px-2 text-[12.5px]" style={{ borderColor: C.chipLine }} />
          </div>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" rows={3} className="rounded-[8px] border px-2.5 py-2 text-[12.5px]" style={{ borderColor: C.chipLine }} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Cancel</button>
          <button type="button" onClick={save} disabled={!title.trim()} className="rounded-[8px] px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40" style={{ background: C.forestDeep }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ── disclosure footer ──────────────────────────────────────────────────────
function Footer({ cards, nowMs, boardName }: { cards: KanbanCard[]; nowMs: number; boardName: string }) {
  const withEst = cards.filter((c) => cardEstimatedHours(c) !== null);
  const noEst = cards.length - withEst.length;
  const hrs = withEst.reduce((s, c) => s + (cardEstimatedHours(c) ?? 0), 0);
  const stale = cards.filter((c) => isStale(c, nowMs));
  const staleIdeas = stale.filter((c) => c.stage === "ideas").length;
  const byP: Record<string, number> = {};
  for (const c of cards) { const p = cardPriority(c) ?? "None"; byP[p] = (byP[p] ?? 0) + 1; }
  const topP = Object.keys(byP).sort((a, b) => byP[b] - byP[a])[0] ?? "None";
  const noOwn = cards.filter((c) => !c.owner_user_id).length;
  const noDesc = cards.filter((c) => !(typeof c.data?.description === "string" && (c.data.description as string).trim())).length;

  const text = cards.length === 0
    ? `This board has no cards yet. Ages are counted in whole days from today, ${dfull(nowMs)}. Nothing on this page writes anywhere except moving a card between columns, which resets that card's clock.`
    : `This board holds ${plural(cards.length, "card")}; each column header counts the cards in it, and shows "N of M" when a filter is hiding some. ` +
      `A card is flagged when it has not moved for longer than its column allows: ${STALE_ACTIVE_DAYS} days for In plan and In progress, ${STALE_IDEA_DAYS} days for Ideas, and never for Shipped — ` +
      `${stale.length} card${stale.length === 1 ? " is" : "s are"} flagged right now, of which ${staleIdeas} ${staleIdeas === 1 ? "is an idea" : "are ideas"}. ` +
      `An idea card prints no age and no flag: a column of ages nobody acts on is noise. The age of the oldest idea is on the column line above, any single idea's age is in its drawer, and "only what is stuck" still finds them. ` +
      `Changed in ${FRESH_WINDOW_DAYS} days means the card was created or moved to another column inside that window; ideas do not change column, so for an idea it means it was written down that recently. ` +
      `Estimates are typed by hand and most cards do not carry one: ${withEst.length} of ${cards.length} do, totalling ${plural(hrs, "hour")}, and the other ${noEst} have none — which is why this page prints no board total, because a total across ${withEst.length} of ${plural(cards.length, "card")} is not the board's total. ` +
      `Priority is typed by hand too, and ${byP[topP]} of the ${plural(cards.length, "card")} ${cards.length === 1 ? "is" : "are"} marked ${topP}${byP[topP] > cards.length / 2 ? ", so priority is not currently separating one card from another" : ""}. ` +
      `${noOwn} card${noOwn === 1 ? " has" : "s have"} no owner and ${noDesc} ${noDesc === 1 ? "has" : "have"} no description written, so those cannot be picked up without asking somebody. ` +
      `Ages are counted in whole days from today, ${dfull(nowMs)}. Nothing on this page writes anywhere except moving a card between columns, which resets that card's clock.`;

  return <div data-testid="footer" className="mt-3.5 rounded-[12px] border p-[14px_16px] text-[12px] leading-[1.65]" style={{ background: C.surface, borderColor: C.line, color: C.muted }}>{text}</div>;
}
