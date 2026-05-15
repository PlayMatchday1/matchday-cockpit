import AdminGuard from "@/components/AdminGuard";
import CrmClient from "./CrmClient";

// Phase 0 CRM MVP — corp-only two-way SMS over Telnyx. AdminGuard
// is the page-level gate (app_users.is_admin = true); the API routes
// also enforce the same check server-side, so this is defense in
// depth, not the only line of authorization.

export default function CrmPage() {
  return (
    <AdminGuard>
      <CrmClient />
    </AdminGuard>
  );
}
