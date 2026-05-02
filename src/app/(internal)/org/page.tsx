import OrgChart from "@/components/OrgChart";
import PageHeader from "@/components/PageHeader";
import PagePermissionGuard from "@/components/PagePermissionGuard";

export default function OrgPage() {
  return (
    <PagePermissionGuard page="org">
      <PageHeader
        title="Org"
        subtitle="Teams, people, and reporting structure."
      />
      <OrgChart />
    </PagePermissionGuard>
  );
}
