import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import FieldIdAdminView from "@/components/FieldIdAdminView";
import PageHeader from "@/components/PageHeader";

export default function AdminFieldsPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · Fields"
        subtitle="Every MatchDay field ID, and which venue it is mapped to. Unmapped first — that is money reaching Finance attributed to nothing."
      />
      <AdminSubNav active="fields" />
      <FieldIdAdminView />
    </AdminGuard>
  );
}
