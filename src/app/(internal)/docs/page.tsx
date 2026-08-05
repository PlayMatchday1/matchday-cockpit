import DocsList from "@/components/DocsList";
import PageHeader from "@/components/PageHeader";
import PagePermissionGuard from "@/components/PagePermissionGuard";

export default function DocsPage() {
  return (
    <PagePermissionGuard page="tech">
      <PageHeader
        title="Docs"
        subtitle="Quick links to Google Drive resources."
      />
      <DocsList />
    </PagePermissionGuard>
  );
}
