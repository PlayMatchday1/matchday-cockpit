import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import CrmSubTabStrip from "@/components/CrmSubTabStrip";
import MatchChatsClient from "./MatchChatsClient";

// Two-pane Match Chats console. Left = tabbed inbox (Active /
// Upcoming), right = selected chat with realtime listener and
// composer. URL state: ?chatId=…&tab=active|upcoming.
//
// The sub-tab strip at the top lets operators bounce between Player
// Chat (/crm) and Match Chats (/match-chats) without going through
// the top nav — both surfaces handle live player conversations.

export const metadata: Metadata = {
  title: "Match Chats",
};

export default function MatchChatsPage() {
  return (
    <AdminGuard>
      <CrmSubTabStrip />
      <Suspense fallback={null}>
        <MatchChatsClient />
      </Suspense>
    </AdminGuard>
  );
}
