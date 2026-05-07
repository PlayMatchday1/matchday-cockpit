import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import MonthlyReportGenerator from "@/components/MonthlyReportGenerator";
import PageHeader from "@/components/PageHeader";

export default function AdminReportsPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · Reports"
        subtitle="Generate the monthly city manager email."
      />
      <AdminSubNav active="reports" />
      <MonthlyReportGenerator />
    </AdminGuard>
  );
}
