import OrgChart from "@/components/OrgChart";
import PageHeader from "@/components/PageHeader";

export default function OrgPage() {
  return (
    <>
      <PageHeader
        title="Org"
        subtitle="Teams, people, and reporting structure."
      />
      <OrgChart />
    </>
  );
}
