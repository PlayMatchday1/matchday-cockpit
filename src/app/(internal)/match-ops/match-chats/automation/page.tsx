import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import AutomationClient from "./AutomationClient";

// Automated Chat Messaging — the merged Veo (film links) + Community (invite-link
// posting) configuration, moved off the old Field Ops ?fo=veo / ?fo=community
// tabs. Admin-only, matching the old tabs' gating (both dashboards' /api routes
// require is_admin). Reached from the "Automated messaging" button on Match
// Chats — deliberately NOT a rail item.

export const metadata: Metadata = { title: "Automated Chat Messaging" };

export default function AutomationPage() {
  return (
    <AdminGuard>
      <AutomationClient />
    </AdminGuard>
  );
}
