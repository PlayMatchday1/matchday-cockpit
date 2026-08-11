"use client";

// Phase 19 Step 3a — the DOCKED player chat (read-only shell). An operator pins a player's
// conversation and it follows them across every Match Ops screen, so they can work the player's
// problem on one screen while keeping the conversation in view. This commit is READ-ONLY: it
// renders the identity, the two identity banners, the message history and a "Reply in Player
// Chats" hand-off. The composer / send path is Step 3b.
//
// State lives in the CRM provider (crmConversation): the docked conversation is one slot in the
// SAME conversations map the Chats pane reads, so realtime paints it exactly once. This component
// is pure presentation over that state.
//
// Three forms: an expanded PANEL (dockOpen), a collapsed RAIL on the right edge (desktop) and a
// collapsed BUBBLE (phones). ChatsRail owns the LEFT edge; the dock owns the RIGHT edge — opposite
// edges, no collision. The dock is mounted by match-ops/layout.tsx and hidden on Player Chats
// itself (the full inbox is already there).

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, X, ChevronRight, Reply, AlertTriangle, Users, Unlink } from "lucide-react";
import PlayerAvatar from "@/components/PlayerAvatar";
import CityChip from "@/components/CityChip";
import ChannelChip, { channelDisplay } from "@/components/ChannelChip";
import MessageBubble from "@/app/(internal)/match-ops/player-chats/components/MessageBubble";
import {
  useCrmConversation,
  markThreadRead,
  type ThreadDetail,
  type ThreadListRow,
} from "@/lib/crmConversation";

const PLAYER_CHATS_PATH = "/match-ops/player-chats";
const SWITCHER_MAX = 4;

function nameOf(t: ThreadListRow): string {
  const first = t.player?.first_name?.trim() ?? "";
  const last = t.player?.last_name?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  return full || t.phone_number;
}

// A real city code, or null — never the "UNK" placeholder, which reads like a city we failed to
// load rather than one we don't have.
function cityCodeOrNull(t: ThreadListRow): string | null {
  const c = t.player?.preferable_city_normalized;
  return c && c.length > 0 ? c : null;
}

// Banner B fires only when BOTH sides name a concrete, DIFFERENT player. A thread with no player_id
// (unlinked phone) or a screen with no subject can't be a "mismatch" — it's a different case.
function subjectMismatch(
  threadPlayerId: number | null,
  subjectPlayerId: string | number | null | undefined,
): boolean {
  if (threadPlayerId == null || subjectPlayerId == null) return false;
  return String(threadPlayerId) !== String(subjectPlayerId);
}

export default function CrmDock() {
  const {
    conversations,
    threads,
    setThreads,
    dockedThreadId,
    dockOpen,
    setDockOpen,
    undockThread,
    dockThread,
    dockSubject,
    selectThread,
    realtimeOk,
  } = useCrmConversation();
  const router = useRouter();

  const detail: ThreadDetail | null = dockedThreadId
    ? conversations[dockedThreadId] ?? null
    : null;

  // The switcher lists OTHER threads WITH UNREAD — read from the inbox `threads` list, the SAME
  // is_unread the nav badge sums, not a second counter. Excludes the docked thread, most recent
  // first, capped at four. When empty the whole region is absent from the DOM (below).
  const switchable = useMemo(
    () =>
      threads
        .filter((t) => t.is_unread && t.id !== dockedThreadId)
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))
        .slice(0, SWITCHER_MAX),
    [threads, dockedThreadId],
  );

  // Switch the dock to an unread thread and clear its unread (optimistic, like the inbox row).
  const switchTo = (id: string) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, is_unread: false } : t)));
    void markThreadRead(id);
    dockThread(id);
  };

  // Nothing pinned → the dock is absent entirely (no rail, no bubble).
  if (!dockedThreadId) return null;

  // Pinned but the detail hasn't loaded yet (e.g. a fresh dockThread mid-fetch).
  if (!detail) {
    return (
      <aside
        data-testid="dock-root"
        data-docked-thread-id={dockedThreadId}
        data-guard="loading"
        className="fixed right-3 bottom-3 z-40 flex items-center gap-2 rounded-full border border-cream-line bg-white px-4 py-2 text-xs text-deep-green/60 shadow-lg"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-deep-green/40" />
        Loading chat…
      </aside>
    );
  }

  const t = detail.thread;
  const name = nameOf(t);
  const unlinked = t.player_id == null;
  const ambiguous = t.match_ambiguous === true;
  const cityCode = cityCodeOrNull(t);
  const mismatch = subjectMismatch(t.player_id, dockSubject?.playerId);

  const openInChats = () => {
    selectThread(t.id);
    router.push(`${PLAYER_CHATS_PATH}?threadId=${t.id}`);
  };

  // ---- collapsed: a right-edge RAIL on desktop, a bubble on phones ----
  if (!dockOpen) {
    return (
      <>
        <button
          type="button"
          data-testid="dock-rail"
          data-docked-thread-id={t.id}
          onClick={() => setDockOpen(true)}
          aria-label={`Open docked chat with ${name}`}
          className="fixed right-0 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-center gap-2 rounded-l-xl border border-r-0 border-cream-line bg-white px-1.5 py-3 shadow-lg sm:flex"
        >
          <PlayerAvatar name={name} seed={t.phone_number} channel={t.channel} size="sm" isMember={t.player?.is_member === true} />
          <ChevronRight aria-hidden className="h-4 w-4 text-deep-green/50" />
          {(mismatch || unlinked || ambiguous) && <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-coral" data-testid="dock-rail-warn" />}
        </button>
        <button
          type="button"
          data-testid="dock-bubble"
          data-docked-thread-id={t.id}
          onClick={() => setDockOpen(true)}
          aria-label={`Open docked chat with ${name}`}
          className="fixed right-3 bottom-3 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-deep-green text-white shadow-lg sm:hidden"
        >
          <MessageSquare aria-hidden className="h-5 w-5" />
          {(mismatch || unlinked || ambiguous) && <span data-testid="dock-bubble-warn" className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-coral" />}
        </button>
      </>
    );
  }

  // ---- expanded PANEL ----
  return (
    <aside
      data-testid="dock-root"
      data-docked-thread-id={t.id}
      data-guard="ready"
      data-mismatch={mismatch ? 1 : 0}
      data-unlinked={unlinked ? 1 : 0}
      data-amb={ambiguous ? 1 : 0}
      className="fixed right-0 bottom-0 z-40 flex w-[360px] max-w-[calc(100vw-8px)] flex-col overflow-hidden rounded-tl-xl border border-b-0 border-r-0 border-cream-line bg-white shadow-2xl"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 4rem)" }}
    >
      {/* Banner A — attribution: WHO this docked conversation is with. */}
      <div
        data-testid="dock-banner-a"
        data-thread-id={t.id}
        className="flex shrink-0 items-center gap-2 border-b border-cream-line bg-cream-soft px-2 py-2"
      >
        <PlayerAvatar name={unlinked ? null : name} seed={t.phone_number} channel={t.channel} size="sm" isMember={t.player?.is_member === true} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {unlinked ? (
              // No player name to show — do NOT dress the phone number up as an identity.
              <>
                <span className="truncate font-mono text-sm font-bold tracking-tight text-deep-green">{t.phone_number}</span>
                <span
                  data-testid="dock-unlinked-chip"
                  className="shrink-0 rounded-full bg-muted-soft px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-muted"
                >
                  Unlinked
                </span>
              </>
            ) : (
              <span className="truncate text-sm font-extrabold tracking-tight text-deep-green">{name}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-deep-green/55">
            {cityCode && (
              <>
                <CityChip code={cityCode} />
                <span aria-hidden>·</span>
              </>
            )}
            <span className="inline-flex items-center gap-0.5">
              <ChannelChip channel={t.channel} /> via {channelDisplay(t.channel)}
            </span>
          </div>
        </div>
        <button
          type="button"
          data-testid="dock-collapse"
          onClick={() => setDockOpen(false)}
          aria-label="Collapse docked chat"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/60 hover:bg-white"
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="dock-close"
          onClick={undockThread}
          aria-label="Close docked chat"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/60 hover:bg-white"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>

      {/* Guard: no player account is linked to this number. Informational; blocks nothing. */}
      {unlinked && (
        <div
          data-testid="dock-guard-unlinked"
          className="flex shrink-0 items-start gap-2 border-b border-cream-line bg-muted-soft/40 px-2.5 py-2 text-[11px] text-deep-green/70"
        >
          <Unlink aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>No player account is linked to this number.</span>
        </div>
      )}

      {/* Ambiguity: >1 account shares this number and we attached the newest — it may not be who
          is writing. (No stored candidate count in ThreadDetail, so the generic form.) */}
      {ambiguous && (
        <div
          data-testid="dock-ambiguous"
          className="flex shrink-0 items-start gap-2 border-b border-amber-300/50 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800"
        >
          <Users aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            This number is on more than one account. Showing <strong>{name}</strong> — it may not be who is writing.
          </span>
        </div>
      )}

      {/* Switcher — other threads WITH UNREAD (≤4, most recent first). Absent entirely at zero. */}
      {switchable.length > 0 && (
        <div data-testid="dock-switcher" className="shrink-0 border-b border-cream-line bg-white">
          <div className="px-3 pt-1.5 text-[9px] font-bold uppercase tracking-wide text-deep-green/40">
            Unread ({switchable.length})
          </div>
          {switchable.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`dock-switch-${s.id}`}
              onClick={() => switchTo(s.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-deep-green hover:bg-cream-soft"
            >
              <PlayerAvatar name={s.player ? nameOf(s) : null} seed={s.phone_number} channel={s.channel} size="sm" isMember={s.player?.is_member === true} />
              <span className="truncate font-semibold">{nameOf(s)}</span>
              <span aria-hidden className="ml-auto h-2 w-2 shrink-0 rounded-full bg-coral" />
            </button>
          ))}
        </div>
      )}

      {/* Banner B — mismatch: you're on a screen about a DIFFERENT player than this chat. */}
      {mismatch && (
        <div
          data-testid="dock-banner-b"
          className="flex shrink-0 items-start gap-2 border-b border-coral/30 bg-coral/10 px-2.5 py-2 text-[11px] text-coral"
        >
          <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            You're working on <strong>{dockSubject?.label ?? "another player"}</strong> — this chat is with{" "}
            <strong>{name}</strong>.
          </span>
        </div>
      )}

      {/* read-only message history */}
      <div data-testid="dock-messages" className="flex-1 overflow-y-auto bg-cream-soft/40 px-2 py-2" style={{ maxHeight: "min(52vh, 460px)" }}>
        {detail.messages.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-deep-green/40">No messages yet.</div>
        ) : (
          <ul className="flex flex-col">
            {detail.messages.map((m) => (
              <MessageBubble key={m.id} msg={m} className="mt-1.5" />
            ))}
          </ul>
        )}
      </div>

      {/* read-only footer — the send path is Step 3b. Hand off to the full pane instead. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-cream-line bg-white px-2.5 py-2">
        <span className="text-[10px] text-deep-green/45">
          {realtimeOk === false ? "Reconnecting…" : "Read-only"}
        </span>
        <button
          type="button"
          data-testid="dock-reply"
          onClick={openInChats}
          className="inline-flex items-center gap-1.5 rounded-full bg-deep-green px-3 py-1.5 text-xs font-bold text-white hover:bg-deep-green/90"
        >
          <Reply aria-hidden className="h-3.5 w-3.5" /> Reply in Player Chats
        </button>
      </div>
    </aside>
  );
}
