import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import VenuesFieldsView from "@/components/VenuesFieldsView";
import PageHeader from "@/components/PageHeader";

export default function AdminFieldsPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Venues & Fields"
        subtitle="What we call each place, and every field ID that lands on it. Unmapped first — that is money reaching Finance attributed to nothing."
      />
      <AdminSubNav active="fields" />
      <VenuesFieldsView />
    </AdminGuard>
  );
}
