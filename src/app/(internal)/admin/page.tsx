import AdminGuard from "@/components/AdminGuard";
import AdminUsersView from "@/components/AdminUsersView";
import PageHeader from "@/components/PageHeader";

export default function AdminPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · User access"
        subtitle="Who can sign in, and what each person can see."
      />
      <AdminUsersView />
    </AdminGuard>
  );
}
