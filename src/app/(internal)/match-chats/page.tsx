import { Suspense } from "react";
import AdminGuard from "@/components/AdminGuard";
import MatchChatsClient from "./MatchChatsClient";

// Phase 3 — two-pane Match Chats console. Left = tabbed inbox
// (Active / Upcoming), right = selected chat with realtime listener
// and composer. URL state: ?chatId=…&tab=active|upcoming.
//
// No PageHeader: the shell uses its own dense chrome to claim the
// full viewport height for the two panes.

export default function MatchChatsPage() {
  return (
    <AdminGuard>
      {/* Suspense boundary required by Next 16 for any client tree
          that calls useSearchParams. */}
      <Suspense fallback={null}>
        <MatchChatsClient />
      </Suspense>
    </AdminGuard>
  );
}
