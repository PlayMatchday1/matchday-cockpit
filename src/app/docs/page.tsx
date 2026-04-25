import DocsList from "@/components/DocsList";
import PageHeader from "@/components/PageHeader";

export default function DocsPage() {
  return (
    <>
      <PageHeader
        title="Docs"
        subtitle="Quick links to Google Drive resources."
      />
      <DocsList />
    </>
  );
}
