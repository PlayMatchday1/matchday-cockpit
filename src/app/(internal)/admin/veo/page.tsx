import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import PageHeader from "@/components/PageHeader";
import VeoDashboard from "@/components/VeoDashboard";

export default function VeoPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · Veo auto-poster"
        subtitle="Veo recordings matched to scheduled matches and posted into their Cockpit thread. Anything not confidently matched lands in the review queue below — never blind-posted."
      />
      <AdminSubNav active="veo" />
      <VeoDashboard />
    </AdminGuard>
  );
}
