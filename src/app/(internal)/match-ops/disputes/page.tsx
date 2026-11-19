// Disputes: Match Ops › Daily Ops › Operations (Ryan, 2026-11-18). Admins only for now: every route
// behind it is authenticateAdmin, and the rail item is drawn for admins only (access "admin").
import AdminGuard from "@/components/AdminGuard";
import DisputesView from "@/components/DisputesView";

export default function DisputesPage() {
  return (
    <AdminGuard>
      <DisputesView />
    </AdminGuard>
  );
}
