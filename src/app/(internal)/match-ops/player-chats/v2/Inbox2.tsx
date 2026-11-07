"use client";

// PLAYER CHATS 2.0 (Figma 9TgSk4sYqq4nNoTH73wRRs, page "Clubhouse · Player Chats 2.0").
//
// Two panes, queue and conversation; Player details docks on the right at 400px and collapses the
// queue to a column of faces (frame 2). Below 1024px: one pane at a time — the queue, then the
// conversation with a back arrow, then details with a back arrow.
//
// A FRONT-END REBUILD. The data layer is the same CrmConversationProvider (one realtime channel,
// mounted in the Match Ops layout), and every read and write is a route the old page already used:
// the list, the conversation, mark-read, send / send-media / send-template (inside Composer), the
// draft card, the thread actions (useThreadActions), the context read (useThreadContext), the
// credit write (GiveCreditPanel / CreditBox), App activity. Shown per browser behind
// src/lib/chatsInboxChoice.ts; the old page stays for everyone else.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleDollarSign, X as XIcon, XCircle } from "lucide-react";
import { useAuth, canEditCredits, canViewActivity } from "@/lib/useAuth";
import { useCrmConversation, markThreadRead, type ThreadListRow } from "@/lib/crmConversation";
import { whatsappWindowExpired, whatsappWindowRemainingMs } from "@/lib/crmWindow";
import { isAwaitingReply } from "@/lib/awaitingReply";
import { rowAttention } from "@/lib/crmAttention";
import { freshAccessToken } from "@/lib/crmSession";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { useAppActivity } from "@/components/AppActivityCard";
import { annotate } from "@/lib/appActivity";
import { appendLine, bucket, dayDivider, nextMatch, waitingCount, type Inbox2Tab, type Section } from "@/lib/inbox2Model";
import type { CrmChannel } from "@/components/ChannelChip";
import MessageBubble, { type ConversationMessage } from "../components/MessageBubble";
import Composer from "../components/Composer";
import TemplateSendModal from "../components/TemplateSendModal";
import MetricsStrip from "../components/MetricsStrip";
import AutoSendPanel from "../components/AutoSendPanel";
import { ThreadCityPicker } from "../CrmClient";
import Queue2, { FacesColumn, NO_FILTERS, cityCodeOf, filtersActive, fullNameOf, type Filters } from "./Queue2";
import PlayerStrip, { type MenuItem } from "./PlayerStrip";
import DetailsPanel, { type ActivityState, type DetailsTab } from "./DetailsPanel";
import GiveCreditPanel from "./GiveCreditPanel";
import { useThreadContext } from "./useThreadContext";
import { useThreadActions } from "./useThreadActions";

const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db", DEEP = "#0e3b2c";

export default function Inbox2({ onUseOld }: { onUseOld: () => void }) {
  const { appUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    threads, setThreads, threadsError, threadsLoading, setThreadsLoading, counts, operators,
    detail, setDetail, detailError, detailLoading, realtimeOk,
    selectedThreadId: selectedId, selectThread, view, nowMs,
    loadThreads, loadDetail, loadOperators, onSent, dockThread, dockedThreadId, drafts, setDraft,
  } = useCrmConversation();
  const actions = useThreadActions();
  const appUserId = appUser?.id ?? null;
  const canSendMessages = appUser?.can_send_messages === true;
  const canManageStatus = appUser?.is_admin === true || appUser?.can_access_chats === true;
  const canActivity = canViewActivity(appUser);

  // ── tabs, on the URL: Done = ?view=closed, Waiting = ?tab=waiting, Needs reply = neither. The old
  // page's ?view=mine / starred / awaiting still load; they show as "Showing: …" with Clear.
  const tab: Inbox2Tab = view === "closed" ? "done" : searchParams.get("tab") === "waiting" ? "waiting" : "needs";
  const legacyView = view === "mine" ? "Mine" : view === "starred" ? "Starred" : view === "awaiting" ? "Awaiting" : null;
  const go = useCallback((next: { view?: string | null; tab?: string | null }) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    const qs = p.toString();
    router.replace(qs ? `/match-ops/player-chats?${qs}` : "/match-ops/player-chats", { scroll: false });
  }, [router, searchParams]);
  const setTab = (t: Inbox2Tab) => go(t === "done" ? { view: "closed", tab: null } : { view: null, tab: t === "waiting" ? "waiting" : null });

  // ── the same orchestration as the old page ──
  useEffect(() => { void loadOperators(); }, [loadOperators]);
  useEffect(() => { setThreadsLoading(true); void loadThreads(); }, [view, loadThreads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void loadThreads(); }, 30_000);
    return () => clearInterval(t);
  }, [loadThreads]);
  useEffect(() => {
    document.documentElement.classList.add("app-shell-locked");
    document.body.classList.add("app-shell-locked");
    return () => { document.documentElement.classList.remove("app-shell-locked"); document.body.classList.remove("app-shell-locked"); };
  }, []);
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (typeof nav.setAppBadge !== "function") return;
    const n = threads.reduce((k, t) => k + (t.is_unread ? 1 : 0), 0);
    if (n === 0) nav.clearAppBadge?.call(navigator).catch(() => {}); else nav.setAppBadge.call(navigator, n).catch(() => {});
  }, [threads]);
  // Opening a thread loads it and marks it read (optimistic, then the server).
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    void loadDetail(selectedId);
    setThreads((prev) => prev.map((t) => (t.id === selectedId ? { ...t, is_unread: false } : t)));
    void markThreadRead(selectedId);
  }, [selectedId, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the queue ──
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const sectionOf = useCallback((t: ThreadListRow): Section => rowAttention({ ...t, awaiting: isAwaitingReply(t) })?.section ?? null, []);
  const filtered = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return threads.filter((t) => {
      // Each tab holds its own status. Switching between Done and the open tabs reloads the list;
      // until it lands, the other view's rows are still in memory and must not be bucketed here.
      if (tab === "done" ? t.status !== "closed" : t.status !== "open" && view !== "starred") return false;
      if (view === "starred" && !t.is_follow_up) return false;
      if (view === "awaiting" && !isAwaitingReply(t)) return false;
      if (filters.cities.size > 0 && !filters.cities.has(cityCodeOf(t))) return false;
      if (filters.starred && !t.is_follow_up) return false;
      if (filters.assigned && t.assigned_to_user_id !== appUserId) return false;
      if (filters.members && t.player?.is_member !== true) return false;
      if (needle && ![fullNameOf(t), t.phone_number, t.last_message_preview ?? ""].join(" ").toLowerCase().includes(needle)) return false;
      return true;
    }).map((t) => ({ ...t, awaiting: isAwaitingReply(t) }));
  }, [threads, view, tab, filters, appUserId]);
  const live = useMemo(() => bucket(filtered, tab, sectionOf), [filtered, tab, sectionOf]);
  // Rows hold still while a pointer is down over the list, so a realtime reorder can't eat a tap.
  const [frozen, setFrozen] = useState<typeof live | null>(null);
  const groups = frozen ?? live;
  // Needs reply's red count: the threads a person owes, from the open list (unfiltered). The Done tab
  // loads the closed list instead, so the last open count is held while it shows.
  const openNeeds = useMemo(() => threads.filter((t) => t.status === "open" && sectionOf({ ...t, awaiting: isAwaitingReply(t) }) === "human").length, [threads, sectionOf]);
  const lastNeeds = useRef(0);
  if (view !== "closed" && !threadsLoading) lastNeeds.current = openNeeds;
  const needsCount = view === "closed" ? lastNeeds.current : openNeeds;
  const waitN = waitingCount(counts);

  // Select mode (bulk Mark done), from the ⋯ menu; open threads only.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => { if (tab === "done") { setSelectMode(false); setSelectedIds(new Set()); } }, [tab]);

  // ── the conversation ──
  const selectedThread = threads.find((t) => t.id === selectedId) ?? detail?.thread ?? null;
  const ctx = useThreadContext(selectedId);
  const prof = ctx.data?.profile ?? null;
  const name = selectedThread ? fullNameOf(selectedThread) : "";
  const firstName = (selectedThread?.player?.first_name ?? prof?.player.name.split(" ")[0] ?? "").trim();
  const channel = ((detail?.thread.channel ?? selectedThread?.channel) ?? "sms") as CrmChannel;
  const expired = detail ? whatsappWindowExpired(detail.thread.channel, detail.latest_inbound_at, nowMs) : false;
  const remainingMs = detail ? whatsappWindowRemainingMs(detail.thread.channel, detail.latest_inbound_at, nowMs) : null;
  const threadStatus = (detail?.thread.status ?? selectedThread?.status ?? "open") as "open" | "closed";

  // One App activity read per player, shared by the strip's line and the Activity tab.
  const activityPlayer = canActivity ? (selectedThread?.player_id ?? prof?.player.id ?? null) : null;
  const act = useAppActivity(FULL_EDITOR_ENV, activityPlayer, 30);
  const activity: ActivityState = activityPlayer == null ? null
    : act.state.phase === "ok" ? { phase: "ok", items: annotate(act.state.data.rows), matches: act.state.data.matches }
    : act.state.phase === "error" ? { phase: "error", error: act.state.error } : { phase: "loading" };

  // Player details: docked on the right; opening it collapses the queue to faces.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("activity");
  const openDetails = (t?: DetailsTab) => { if (t) setDetailsTab(t); setDetailsOpen((o) => (t ? true : !o)); };

  const [creditOpen, setCreditOpen] = useState(false);
  useEffect(() => { setCreditOpen(false); }, [selectedId]);

  const [lightbox, setLightbox] = useState<string | null>(null);
  // Escape closes the image viewer wherever focus is.
  useEffect(() => {
    if (!lightbox) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [lightbox]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [autoSendOpen, setAutoSendOpen] = useState(false);

  const next = prof ? nextMatch(prof.matches) : null;
  const canCredit = canEditCredits(appUser);
  const qa = "inline-flex h-[26px] items-center gap-1.5 rounded-[8px] bg-[#f3f3ef] px-[10px] text-[12px] font-medium text-[#13241d] transition hover:bg-[#e9ebe4] disabled:cursor-not-allowed disabled:opacity-45";
  const quickActions = (
    <>
      <button type="button" data-testid="crm-qa-credit" className={qa} aria-pressed={creditOpen}
        disabled={!prof?.player.id} onClick={() => setCreditOpen((o) => !o)}
        title={!prof?.player.id ? (ctx.data ? "No account details for this number, so there is no balance to credit" : "Loading the account…") : !canCredit ? "Giving credit needs EDIT CREDITS" : "Give credit"}>
        <CircleDollarSign aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} /> <span className="max-[519px]:sr-only">Give credit</span>
      </button>
      {/* CANCEL SPOT IS A LINK (Ryan 2026-11-06, Q3): the match panel for the player's next match,
          where Remove and its paid-spot warning live. Nothing is written from the chat. */}
      {next?.matchId != null ? (
        <a href={`/match-ops/match-panel/${next.matchId}`} data-testid="crm-qa-cancel" className={qa} title={`Open ${next.name} to remove this player`}>
          <XCircle aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} /> <span className="max-[519px]:sr-only">Cancel spot</span>
        </a>
      ) : (
        <button type="button" data-testid="crm-qa-cancel" className={qa} disabled
          title={prof ? "No upcoming match booked" : "No account details for this number"}>
          <XCircle aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} /> <span className="max-[519px]:sr-only">Cancel spot</span>
        </button>
      )}
    </>
  );

  const menu: MenuItem[] = selectedId && selectedThread ? [
    { key: "follow", label: selectedThread.is_follow_up ? "Remove the follow-up star" : "Star for follow-up", onClick: () => void actions.onToggleFollowUp(selectedId, !selectedThread.is_follow_up) },
    ...(threadStatus === "open" ? [selectedThread.no_reply_needed_at
      ? { key: "reply-anyway", label: "Reply anyway (back to Needs reply)", onClick: () => void actions.onSetNoReply(selectedId, "reactivate") }
      : { key: "no-reply", label: "Done · no reply needed", onClick: () => void actions.onSetNoReply(selectedId, "dismiss"), disabled: !isAwaitingReply(selectedThread), title: isAwaitingReply(selectedThread) ? undefined : "Nothing is owed on this thread" }] : []),
    { key: "dock", label: dockedThreadId === selectedId ? "Docked: follows you across Match Ops" : "Dock this chat", onClick: () => dockThread(selectedId), disabled: dockedThreadId === selectedId },
    ...(channel === "whatsapp" ? [{ key: "template", label: "Send an approved WhatsApp template", onClick: () => setTemplateOpen(true), disabled: !appUserId }] : []),
    ...(canManageStatus && tab !== "done" ? [{ key: "select", label: selectMode ? "Leave Select mode" : "Select conversations", onClick: () => { setSelectMode((s) => !s); setSelectedIds(new Set()); } }] : []),
    { key: "stats", label: "Chat stats", onClick: () => setStatsOpen(true) },
    ...(appUser?.is_admin === true ? [{ key: "autosend", label: "Auto-send settings", onClick: () => setAutoSendOpen(true) }] : []),
    { key: "city", node: (
      <span className="flex items-center justify-between gap-2 text-[13px]" style={{ color: INK }}>
        City of this thread
        <ThreadCityPicker threadId={selectedId} code={detail?.thread.city_code ?? null} source={detail?.thread.city_source ?? null} />
      </span>
    ) },
    { key: "old", label: "Back to the old inbox", onClick: onUseOld },
  ] : [];

  // ── the empty state's numbers: this week's chats and median first reply (GET /api/crm/metrics) ──
  const needsEmpty = tab === "needs" && !filtersActive(filters) && !legacyView && !threadsLoading && !threadsError && live.rows.length === 0 && live.auto.length === 0;
  const [week, setWeek] = useState<{ chats: number; median: number | null } | null>(null);
  useEffect(() => {
    if (!needsEmpty || week) return;
    void (async () => {
      const token = await freshAccessToken();
      if (!token) return;
      const r = await fetch("/api/crm/metrics?period=week", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
      const j = r?.ok ? await r.json().catch(() => null) : null;
      if (j?.metrics?.cohort) setWeek({ chats: j.metrics.cohort.conversations, median: j.metrics.cohort.medianFirstResponseMin });
    })();
  }, [needsEmpty, week]);
  const empty = needsEmpty ? (
    <div data-testid="queue-empty" className="mx-[18px] mt-2 flex flex-col items-center gap-[10px] rounded-[12px] border bg-white px-4 py-7 text-center" style={{ borderColor: LINE }}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#e3f7ed]">
        <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke={DEEP} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
      <span className="text-[15px] font-bold" style={{ color: INK }}>Nobody is waiting</span>
      <span className="text-[13px]" style={{ color: MUTED }}>{waitN} conversation{waitN === 1 ? " is" : "s are"} waiting on the player.</span>
      <span className="text-[12px]" style={{ color: "#9aa39f" }} data-testid="queue-empty-week">
        {week ? `This week: ${week.chats} chats · ${fmtMin(week.median)} median first reply` : "This week: reading…"}
      </span>
    </div>
  ) : !threadsLoading && !threadsError && live.rows.length === 0 && live.auto.length === 0 ? (
    <div className="px-[18px] py-8 text-center text-[12px]" style={{ color: FAINT }}>
      {filtersActive(filters) ? (
        <>No conversations match those filters.<br />
          <button type="button" onClick={() => setFilters(NO_FILTERS)} className="mt-3 rounded-full border px-3 py-1 font-semibold" style={{ borderColor: LINE, color: INK }}>Clear filters</button></>
      ) : tab === "done" ? "No closed conversations." : tab === "waiting" ? "Nothing is waiting on a player." : "Nothing here."}
    </div>
  ) : null;
  const shownOpen = threads.filter((t) => t.status === "open").length;
  const listNote = tab === "waiting" && !filtersActive(filters) && waitN > live.rows.length && shownOpen >= 100
    ? `Showing the ${live.rows.length} most recent of ${waitN}. The list loads the latest 100 open conversations.` : null;

  const showQueueMobile = !selectedId;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 lg:pl-[var(--mo-rail-w)]" style={{ background: "#fbfbf9" }} data-testid="inbox2">
      {/* the queue, or its faces while details is open (desktop) */}
      <div className={`${showQueueMobile ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 lg:flex lg:flex-none`}>
        {detailsOpen && selectedId ? (
          <>
            <FacesColumn rows={[...groups.auto, ...groups.rows]} needsCount={needsCount} selectedId={selectedId} tab={tab} nowMs={nowMs}
              onExpand={() => setDetailsOpen(false)} onPick={(id) => { selectThread(id); setDetailsOpen(false); }} />
          </>
        ) : (
          <Queue2 tab={tab} onTab={setTab} needsCount={needsCount} waitingCount={waitN}
            auto={groups.auto} rows={groups.rows} selectedId={selectedId} onSelect={(id) => selectThread(id)}
            nowMs={nowMs} appUserId={appUserId} filters={filters} setFilters={setFilters}
            legacyView={legacyView} onClearLegacy={() => go({ view: null })}
            loading={threadsLoading} error={threadsError} realtimeOk={realtimeOk} onRefresh={() => void loadThreads()}
            selectMode={selectMode} selectedIds={selectedIds}
            onToggleSelected={(id) => setSelectedIds((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onCloseSelected={() => { void actions.onBulkClose([...selectedIds]); setSelectedIds(new Set()); setSelectMode(false); }}
            onExitSelect={() => { setSelectMode(false); setSelectedIds(new Set()); }}
            onHoldChanged={() => void loadThreads()} empty={empty} listNote={listNote} onUseOld={onUseOld}
            freeze={() => setFrozen((p) => p ?? live)} thaw={() => setFrozen(null)} />
        )}
      </div>

      {/* the conversation */}
      <section className={`min-w-0 flex-col bg-[#fbfbf9] lg:static lg:z-auto lg:flex lg:flex-1 ${selectedId ? "fixed inset-0 z-40 flex" : "hidden lg:flex"}`}>
        {!selectedId ? (
          <div className="hidden flex-1 items-center justify-center lg:flex">
            <div className="text-center">
              <div className="text-[14px] font-semibold" style={{ color: INK }}>Select a conversation</div>
              <div className="mt-1 text-[12px]" style={{ color: FAINT }}>Pick a player from the queue to read and reply.</div>
            </div>
          </div>
        ) : (
          <>
            <PlayerStrip detail={detail} name={name} ctx={ctx} operators={operators}
              onAssign={(u) => void actions.onAssign(selectedId, u)} onBack={() => { setDetailsOpen(false); selectThread(null); }}
              threadStatus={threadStatus} canManageStatus={canManageStatus} onSetStatus={(a) => void actions.onSetStatus(selectedId, a)}
              menu={menu} onOpenDetails={openDetails} detailsOpen={detailsOpen} activity={activity} canActivity={canActivity} nowMs={nowMs} />
            <Messages selectedId={selectedId} messages={(detail?.messages ?? []) as ConversationMessage[]} loading={detailLoading} error={detailError} onOpenImage={setLightbox} />
            <Composer
              variant="v2"
              threadId={selectedId}
              appUserId={appUserId}
              canSendMessages={canSendMessages}
              channel={channel}
              whatsappWindowExpired={expired}
              windowClosesInMs={remainingMs}
              latestInboundAt={detail?.latest_inbound_at ?? null}
              customerName={firstName}
              onSent={onSent}
              bodyValue={drafts[selectedId] ?? ""}
              onBodyChange={(text) => setDraft(selectedId, text)}
              draftMessages={(detail?.messages ?? []) as ConversationMessage[]}
              quickActions={quickActions}
              aboveBox={creditOpen && prof?.player.id != null ? (
                <GiveCreditPanel playerId={prof.player.id} playerName={prof.player.name} firstName={firstName}
                  balanceCents={ctx.credits ?? 0} canCredit={canCredit} onBalance={ctx.setLiveCredits}
                  onAddLine={(line) => setDraft(selectedId, appendLine(drafts[selectedId] ?? "", line))}
                  onClose={() => setCreditOpen(false)} />
              ) : null}
            />
          </>
        )}
      </section>

      {detailsOpen && selectedId && selectedThread && (
        <DetailsPanel threadId={selectedId} phone={selectedThread.phone_number} playerId={selectedThread.player_id ?? null} name={name}
          ctx={ctx} tab={detailsTab} onTab={setDetailsTab} onClose={() => setDetailsOpen(false)} activity={activity} />
      )}

      {lightbox && (
        <div role="dialog" aria-label="Image" data-testid="crm-lightbox" className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(9,20,15,.82)] p-6"
          onClick={() => setLightbox(null)} onKeyDown={(e) => { if (e.key === "Escape") setLightbox(null); }} tabIndex={-1}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Attachment" className="max-h-[88vh] max-w-[92vw] rounded-[8px] object-contain" onClick={(e) => e.stopPropagation()} />
          <div className="absolute right-4 top-4 flex gap-2">
            <a href={lightbox} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="rounded-full bg-white/90 px-3 py-1 text-[12px] font-semibold" style={{ color: INK }}>Open original</a>
            <button type="button" aria-label="Close image" onClick={() => setLightbox(null)} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90"><XIcon aria-hidden className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      {selectedId && channel === "whatsapp" && (
        <TemplateSendModal open={templateOpen} onClose={() => setTemplateOpen(false)} threadId={selectedId} initialCustomerName={firstName} onSent={onSent} />
      )}
      {statsOpen && (
        <Modal title="Chat stats" onClose={() => setStatsOpen(false)} wide>
          <MetricsStrip />
        </Modal>
      )}
      {autoSendOpen && appUser?.is_admin === true && (
        <Modal title="Auto-send settings" onClose={() => setAutoSendOpen(false)}>
          <AutoSendPanel />
        </Modal>
      )}
      {actions.closeToast && (
        <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4" style={{ marginBottom: "var(--safe-area-bottom)" }}>
          <div className="pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 text-sm text-white shadow-lg" style={{ background: DEEP }}>
            <span className="font-medium">{actions.closeToast.threadIds.length === 1 ? "Marked done" : `${actions.closeToast.threadIds.length} marked done`}</span>
            <button type="button" data-testid="toast-undo" onClick={() => void actions.onUndoClose(actions.closeToast!.threadIds)} className="rounded-full px-2 py-0.5 text-xs font-bold text-[#2cdb87]">Undo</button>
            <button type="button" aria-label="Dismiss" onClick={actions.dismissToast} className="px-1 text-white/60">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
}

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-[rgba(9,30,20,.28)] px-4 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`max-h-[76vh] w-full overflow-auto rounded-[14px] border bg-white shadow-[0_24px_60px_rgba(9,30,20,.25)] ${wide ? "max-w-[980px]" : "max-w-[420px]"}`} style={{ borderColor: LINE }}>
        <div className="flex items-center border-b px-4 py-3" style={{ borderColor: LINE }}>
          <span className="text-[14px] font-semibold" style={{ color: INK }}>{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto rounded p-1 text-[#5e6b66] hover:bg-[#f3f3ef]"><XIcon aria-hidden className="h-4 w-4" /></button>
        </div>
        <div className="overflow-x-auto">{children}</div>
      </div>
    </div>
  );
}

// ── MESSAGES: compact, day dividers, a time divider after a 2-hour gap, scroll to the newest. ──
function Messages({ selectedId, messages, loading, error, onOpenImage }: {
  selectedId: string; messages: ConversationMessage[]; loading: boolean; error: string | null; onOpenImage: (src: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length, selectedId]);
  const items = useMemo(() => {
    const now = new Date();
    const out: ({ kind: "day"; key: string; label: string } | { kind: "msg"; m: ConversationMessage; gap: boolean })[] = [];
    let prevDay: string | null = null, prevT: number | null = null, prevDir: string | null = null;
    messages.forEach((m, i) => {
      const d = new Date(m.sent_at);
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (day !== prevDay) out.push({ kind: "day", key: `d-${i}`, label: dayDivider(m.sent_at, now) });
      else if (prevT != null && d.getTime() - prevT > 2 * 3600e3) out.push({ kind: "day", key: `g-${i}`, label: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toUpperCase() });
      out.push({ kind: "msg", m, gap: prevDir !== null && prevDir !== m.direction && day === prevDay });
      prevDay = day; prevT = d.getTime(); prevDir = m.direction;
    });
    return out;
  }, [messages]);
  return (
    <div ref={ref} data-testid="crm-messages" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 min-[900px]:px-12">
      {error && <div className="mb-3 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">{error}</div>}
      {loading && messages.length === 0 && <div className="text-[12px]" style={{ color: FAINT }}>Loading messages…</div>}
      {!loading && messages.length === 0 && !error && <div className="text-[12px]" style={{ color: FAINT }}>No messages in this thread yet.</div>}
      <ul className="flex flex-col">
        {items.map((it) => it.kind === "day" ? (
          <li key={it.key} className="flex justify-center pb-[6px] pt-[10px]" aria-label={`Conversation divider: ${it.label}`}>
            <span className="text-[11px] font-semibold tracking-[0.06em]" style={{ color: "#9aa39f" }}>{it.label}</span>
          </li>
        ) : (
          <MessageBubble key={it.m.id} msg={it.m} variant="v2" onOpenImage={onOpenImage} className={it.gap ? "mt-4" : "mt-[6px]"} />
        ))}
      </ul>
    </div>
  );
}
