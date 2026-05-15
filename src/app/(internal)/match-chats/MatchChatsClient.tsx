"use client";

// Two-pane shell for /match-chats. Owns the URL state
// (?chatId=…&tab=active|upcoming) and wires the inbox to the chat
// pane. No full-page navigation between conversations — selecting a
// row updates the right pane in place and pushes the new chatId to
// the URL via router.replace so the link is shareable.

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import MatchChatsInbox, {
  type InboxTab,
} from "./MatchChatsInbox";
import ChatPane from "./ChatPane";
import { isValidChatId } from "@/lib/matchChats";

function readTab(search: URLSearchParams): InboxTab {
  const raw = search.get("tab");
  return raw === "upcoming" ? "upcoming" : "active";
}

function readChatId(search: URLSearchParams): string | null {
  const raw = search.get("chatId");
  if (!raw) return null;
  // Numeric-id guard — refuses the 7 phantom non-numeric chats.
  return isValidChatId(raw) ? raw : null;
}

export default function MatchChatsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tab = useMemo(() => readTab(searchParams), [searchParams]);
  const selectedChatId = useMemo(
    () => readChatId(searchParams),
    [searchParams],
  );

  // Write a single URL update preserving other params. router.replace
  // keeps us out of browser history (no back-button noise per row
  // click).
  const updateParams = useCallback(
    (patch: { chatId?: string | null; tab?: InboxTab }) => {
      const next = new URLSearchParams(searchParams.toString());
      if ("chatId" in patch) {
        if (patch.chatId == null) next.delete("chatId");
        else next.set("chatId", patch.chatId);
      }
      if ("tab" in patch && patch.tab) {
        if (patch.tab === "active") next.delete("tab");
        else next.set("tab", patch.tab);
      }
      const qs = next.toString();
      router.replace(qs ? `/match-chats?${qs}` : "/match-chats", {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  return (
    <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem)] bg-cream">
      <MatchChatsInbox
        selectedChatId={selectedChatId}
        tab={tab}
        onSelect={(chatId) => updateParams({ chatId })}
        onTabChange={(t) => updateParams({ tab: t })}
      />
      <ChatPane chatId={selectedChatId} />
    </div>
  );
}
