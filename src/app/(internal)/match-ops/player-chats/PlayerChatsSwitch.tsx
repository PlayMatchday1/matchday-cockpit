"use client";

// The old Player Chats or Player Chats 2.0, per browser (src/lib/chatsInboxChoice.ts). Both read the
// same CrmConversationProvider, the same routes and the same write paths; only the page differs.

import { useAuth } from "@/lib/useAuth";
import { useInbox2Choice } from "@/lib/chatsInboxChoice";
import CrmClient from "./CrmClient";
import Inbox2 from "./v2/Inbox2";

export default function PlayerChatsSwitch() {
  const { appUser } = useAuth();
  const { on, set } = useInbox2Choice(appUser?.id ?? null);
  // Until the stored choice is read, render neither: a flash of the old page would mark a thread
  // read through the wrong surface's effects and then unmount it.
  if (on == null) return null;
  return on ? <Inbox2 onUseOld={() => set(false)} /> : <CrmClient onTryNew={() => set(true)} />;
}
