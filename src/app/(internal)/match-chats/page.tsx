import AdminGuard from "@/components/AdminGuard";
import PageHeader from "@/components/PageHeader";
import MatchChatsInbox from "./MatchChatsInbox";

// Phase 3 — Match Chats inbox. Two-section layout: Active (chats with
// recent message activity) + Upcoming (matches in the next 3 days
// without recent activity). Real-time updates land on the detail
// page; the inbox itself refreshes via a manual button + on focus.

export default function MatchChatsPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Match Chats"
        subtitle="Group conversations attached to each match. Replies post as MatchDay."
      />
      <MatchChatsInbox />
    </AdminGuard>
  );
}
