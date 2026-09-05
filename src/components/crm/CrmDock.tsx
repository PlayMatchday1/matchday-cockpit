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

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, X, ChevronRight, AlertTriangle, Users, Unlink, RotateCw, IdCard, Maximize2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { accountFromProfile, billingLine, dockSnippets, type DockAccount } from "@/lib/dockAccount";
import { money } from "@/lib/playerLookupModel";
import PlayerAvatar from "@/components/PlayerAvatar";
import CityChip from "@/components/CityChip";
import ChannelChip, { channelDisplay } from "@/components/ChannelChip";
import MessageBubble from "@/app/(internal)/match-ops/player-chats/components/MessageBubble";
import Composer from "@/app/(internal)/match-ops/player-chats/components/Composer";
import { useAuth } from "@/lib/useAuth";
import { whatsappWindowExpired, whatsappWindowRemainingMs } from "@/lib/crmWindow";
import {
  useCrmConversation,
  markThreadRead,
  bearerHeaders,
  type ThreadDetail,
  type ThreadListRow,
  type Message,
} from "@/lib/crmConversation";

const PLAYER_CHATS_PATH = "/match-ops/player-chats";
const PLAYER_LOOKUP_PATH = "/match-ops/player-lookup";
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
    drafts,
    setDraft,
    onSent,
    nowMs,
  } = useCrmConversation();
  const router = useRouter();
  const { appUser } = useAuth();
  const appUserId = appUser?.id ?? null;
  const canSendMessages = appUser?.can_send_messages === true;
  // Per-message in-flight guard for Resend — one attempt, no double-fire (Step 3b, item 4).
  const [resendingId, setResendingId] = useState<string | null>(null);

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

  /* THE FOUR NUMBERS THE DOCK WAS SENDING PEOPLE AWAY TO READ.
   *
   * Fetched from /api/lookup/{env}?id= — the SAME route Player Lookup uses, so played, upcoming,
   * credits and strikes in the dock cannot drift from the page this panel now links to. It is a
   * read-only route behind the Match Ops gate; nothing here writes.
   *
   * Deliberately cheap about WHEN: only while the panel is OPEN, only for a linked thread, once per
   * player. The dock is mounted on every Match Ops screen, so a fetch on mount would put a MatchDay
   * API round trip behind every navigation in the app whether or not anybody looked at it. */
  const [account, setAccount] = useState<DockAccount | null>(null);
  /* THE "ALREADY FETCHED" MARKER IS A REF, AND THAT IS NOT A STYLE CHOICE. As state in the
   * dependency array it made the effect cancel its own request: the run set the marker, the marker
   * changed, the effect re-ran, React fired the FIRST run's cleanup, and the cleanup flipped the
   * `live` flag the in-flight response was waiting on. The fetch returned 200 every time and the
   * strip never appeared — a bug with no error, no warning and no failed request to find. */
  const accountFor = useRef<number | null>(null);
  const linkedPlayerId = detail?.thread.player_id ?? null;
  const wantAccount = dockOpen ? linkedPlayerId : null;
  useEffect(() => {
    if (wantAccount == null || wantAccount === accountFor.current) return;
    let live = true;
    accountFor.current = wantAccount;
    setAccount(null);
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        const res = await fetch(`/api/lookup/${FULL_EDITOR_ENV}?id=${wantAccount}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
        });
        if (!res.ok) return;
        const j: unknown = await res.json();
        if (live) setAccount(accountFromProfile(j));
      } catch {
        /* the strip is an accelerator, not the record — it simply does not appear */
      }
    })();
    return () => { live = false; };
  }, [wantAccount]);

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

  /* THE ONE JOURNEY THE PIN EXISTS FOR, WHICH THE PIN DID NOT HAVE. The dock had exactly one
   * navigation and it went to Player Chats. To look the player up you read the phone number off
   * this header and typed it into the search box on the page you were already standing on. The
   * dock has held t.player_id all along. Absent entirely when the thread is unlinked — there is no
   * player to open, and a control that cannot work should not be on screen. */
  const openInLookup = () => {
    if (t.player_id == null) return;
    router.push(`${PLAYER_LOOKUP_PATH}?id=${t.player_id}`);
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

  // ---- send-path derived state (Step 3b) ----
  // Window read from conversations[threadId].latest_inbound_at — kept fresh by the crm_messages
  // INSERT + crm_threads UPDATE handlers (3a) — re-evaluated on the provider's 30s `nowMs` tick.
  const expired = whatsappWindowExpired(t.channel, detail.latest_inbound_at, nowMs);
  const remainingMs = whatsappWindowRemainingMs(t.channel, detail.latest_inbound_at, nowMs);
  const firstName = t.player?.first_name?.trim() ?? "";
  // The Send button NAMES the recipient. On a mismatch it says who you're actually talking to and
  // who you're not — that IS the guard, no modal (item 3). nameOf → player name, or the phone when
  // unlinked, so "Send to {name}" / "Send to {phone}" fall out of the same expression.
  const sendLabel = mismatch
    ? `Send to ${name}, not ${dockSubject?.label ?? "them"}`
    : "Send";
  /* KEYED OFF THE CONVERSATION, NOT THE SCREEN. dockSubject.snippets are Player Lookup's lines,
   * offered on whatever panel happens to be open — which is how a player asking for a refund was
   * offered "Which city are you playing in?". See src/lib/dockAccount.ts for why the rules live in
   * a pure function. A snippet still only inserts. */
  const snippets = dockSnippets(account, { canSend: canSendMessages });
  const billing = billingLine(account);

  /* WHAT GOES IN THE NAME SLOT WHEN THERE IS NO NAME.
   *
   * nameOf() falls back to the phone number, and that fallback is right where it is used as an
   * IDENTIFIER — the send label, the banners, the aria-labels — because there the number IS how you
   * say who you are about to message. It is wrong in a heading, where it collapsed two different
   * states into the same digits: "no player account is linked to this number", and "this player's
   * account exists and its name field is empty". Measured on a real thread: player 68285 has an
   * account and rendered as +15716662882, indistinguishable at a glance from an unlinked thread.
   *
   * So the heading names a person or says plainly that it cannot, and the number lives on the
   * second line in both cases. nameOf() itself is untouched. */
  const threadName = [t.player?.first_name?.trim(), t.player?.last_name?.trim()].filter(Boolean).join(" ");
  const accountName = account && !/^User \d+$/.test(account.name) ? account.name : null;
  const headerName = unlinked
    ? "Unknown number"
    : threadName || accountName || `Player ${t.player_id}`;

  // Resend a delivery-failed bubble — a FRESH send (no Idempotency-Key, so never an auto-retry),
  // one click, one attempt, disabled while in flight (item 4). Confirm-then-append: the new bubble
  // appears only on 2xx; a failure leaves the original failed bubble untouched.
  const resend = async (m: Message) => {
    if (resendingId) return;
    setResendingId(m.id);
    try {
      const headers = await bearerHeaders();
      if (!headers) return;
      const res = await fetch("/api/crm/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ thread_id: m.thread_id, body: m.body }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: Message };
      if (res.ok && j.message) onSent(j.message);
    } catch {
      /* keep the failed bubble; the operator can try again */
    } finally {
      setResendingId(null);
    }
  };

  // A snippet INSERTS into the draft (appends) — it never sends (item 5).
  const insertSnippet = (text: string) => {
    const cur = drafts[t.id] ?? "";
    setDraft(t.id, cur ? `${cur} ${text}` : text);
  };

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
      style={{ top: "calc(env(safe-area-inset-top, 0px) + var(--nav-h))" }}
    >
      {/* Banner A — attribution: WHO this docked conversation is with. */}
      <div
        data-testid="dock-banner-a"
        data-thread-id={t.id}
        className="flex shrink-0 items-center gap-2 border-b border-cream-line bg-cream-soft px-2 py-2"
      >
        <PlayerAvatar name={unlinked ? null : name} seed={t.phone_number} channel={t.channel} size="sm" isMember={t.player?.is_member === true} />
        {/* THE NAME SLOT HOLDS A NAME, OR SAYS IT HAS NONE. nameOf() falls back to the phone
            number, so "we do not know who this is" and "we know exactly who this is and their name
            field is empty" rendered nearly identically — the same digits, in the same place, one
            with a small chip. The number now always sits on the second line where it belongs, and
            the unlinked case says so in words. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {unlinked ? (
              <span className="truncate text-sm font-extrabold tracking-tight text-muted" data-testid="dock-name">{headerName}</span>
            ) : (
              <span className="truncate text-sm font-extrabold tracking-tight text-deep-green" data-testid="dock-name">{headerName}</span>
            )}
            {unlinked && (
              <span
                data-testid="dock-unlinked-chip"
                className="shrink-0 rounded-full bg-coral/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-coral"
              >
                Unlinked
              </span>
            )}
            {account?.level != null && (
              <span className="shrink-0 rounded-full bg-white px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-deep-green/55">
                Level {account.level}
              </span>
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
              <ChannelChip channel={t.channel} />
            </span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono" data-testid="dock-phone">{t.phone_number}</span>
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

      {/* WHAT THE OPERATOR WOULD OTHERWISE NAVIGATE AWAY TO READ. Not new data — the same four
          numbers Player Lookup prints for this player, from the same route, one page away until
          now. Absent for an unlinked thread, and absent until the fetch lands rather than showing
          four zeros, which would read as a player with nothing on their record. */}
      {account && (
        <div data-testid="dock-facts" className="shrink-0 border-b border-cream-line bg-white px-2.5 py-2">
          <div className="grid grid-cols-4 gap-1 text-center">
            {([
              ["played", String(account.played)],
              ["upcoming", String(account.upcoming)],
              ["credits", money(account.credits)],
              ["strikes", `${account.strikes}/${account.strikeLimit}`],
            ] as const).map(([k, v]) => (
              <div key={k} data-testid={`dock-fact-${k}`}>
                <div className="text-sm font-extrabold leading-tight tracking-tight text-deep-green tabular-nums">{v}</div>
                <div className="text-[9px] uppercase tracking-wide text-deep-green/45">{k}</div>
              </div>
            ))}
          </div>
          {/* The fact the pinned conversation is usually about. */}
          {billing && (
            <div
              data-testid="dock-billing"
              className={`mt-1.5 rounded-md px-2 py-1 text-[10.5px] ${account.membership?.canceledAt ? "bg-coral/10 text-coral" : "bg-cream-soft text-deep-green/70"}`}
            >
              {billing}
            </div>
          )}
        </div>
      )}

      {/* Where the panel hands off. Both routes sit together in one row: a full-pane link directly
          under a reply box reads as "the reply box is not the real place to reply". */}
      <div data-testid="dock-actions" className="flex shrink-0 items-center gap-1.5 border-b border-cream-line bg-white px-2.5 py-1.5">
        {!unlinked && (
          <button
            type="button"
            data-testid="dock-open-lookup"
            onClick={openInLookup}
            className="inline-flex items-center gap-1 rounded-full border border-cream-line bg-cream-soft px-2 py-0.5 text-[10px] font-bold text-deep-green hover:bg-cream-line"
          >
            <IdCard aria-hidden className="h-3 w-3" /> Open in Player Lookup
          </button>
        )}
        <button
          type="button"
          data-testid="dock-reply"
          onClick={openInChats}
          className="inline-flex items-center gap-1 rounded-full border border-cream-line bg-white px-2 py-0.5 text-[10px] font-bold text-deep-green/70 hover:bg-cream-soft"
        >
          <Maximize2 aria-hidden className="h-3 w-3" /> Full pane
        </button>
        <span className="ml-auto text-[10px] text-deep-green/45">{realtimeOk === false ? "Reconnecting…" : ""}</span>
      </div>

      {/* message history — a delivery-failed OUTBOUND bubble gets a Resend (item 4).
          NO maxHeight. `flex-1` says fill the panel and `maxHeight: min(46vh, 420px)` said stop at
          420px; the cap won, so on a tall window everything below the composer was empty. */}
      <div data-testid="dock-messages" className="flex-1 overflow-y-auto bg-cream-soft/40 px-2 py-2">
        {detail.messages.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-deep-green/40">No messages yet.</div>
        ) : (
          <ul className="flex flex-col">
            {detail.messages.map((m) => (
              <Fragment key={m.id}>
                <MessageBubble msg={m} className="mt-1.5" />
                {m.direction === "outbound" && m.delivery_status === "failed" && canSendMessages && (
                  <li className="mt-0.5 flex justify-end">
                    <button
                      type="button"
                      data-testid={`dock-resend-${m.id}`}
                      onClick={() => void resend(m)}
                      disabled={resendingId === m.id}
                      className="inline-flex items-center gap-1 rounded-full border border-coral/40 bg-coral/5 px-2 py-0.5 text-[10px] font-bold text-coral disabled:opacity-50"
                    >
                      <RotateCw aria-hidden className="h-3 w-3" /> {resendingId === m.id ? "Resending…" : "Resend"}
                    </button>
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        )}
      </div>

      {/* snippets — per-screen canned lines; a click INSERTS into the draft, never sends (item 5) */}
      {snippets.length > 0 && (
        <div data-testid="dock-snippets" className="flex shrink-0 flex-wrap gap-1 border-t border-cream-line bg-white px-2 py-1.5">
          {snippets.map((s, i) => (
            <button
              key={i}
              type="button"
              data-testid={`dock-snippet-${i}`}
              onClick={() => insertSnippet(s)}
              className="max-w-full truncate rounded-full border border-cream-line bg-cream-soft px-2 py-0.5 text-[10px] text-deep-green/80 hover:bg-cream-line"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* composer — the SAME Composer as the full pane, compact + draft-backed. Item 12: no SEND
          right ⇒ NO composer at all (not a greyed one), just a stated read-only line. */}
      {canSendMessages ? (
        <Composer
          threadId={t.id}
          appUserId={appUserId}
          canSendMessages={canSendMessages}
          channel={t.channel}
          whatsappWindowExpired={expired}
          windowClosesInMs={remainingMs}
          customerName={firstName}
          onSent={onSent}
          bodyValue={drafts[t.id] ?? ""}
          onBodyChange={(text) => setDraft(t.id, text)}
          sendLabel={sendLabel}
          compact
          onOpenInFullPane={openInChats}
        />
      ) : (
        <div data-testid="dock-readonly" className="shrink-0 border-t border-cream-line bg-white px-2.5 py-2 text-[10px] text-deep-green/45">
          You don&apos;t have permission to send messages (read-only).
        </div>
      )}

    </aside>
  );
}
