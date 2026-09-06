import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import VeoDayOps from "@/components/VeoDayOps";

// Veo — one day of camera matches and the state of each film. Read-only: every control that would
// write a message into a player chat ships disabled until it is wired, rather than looking live.
export const metadata: Metadata = { title: "Veo" };

export default function VeoPage() {
  return (
    <PagePermissionGuard page="matchops">
      <VeoDayOps />
    </PagePermissionGuard>
  );
}
