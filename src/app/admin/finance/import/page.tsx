import AdminGuard from "@/components/AdminGuard";
import FinanceImportView from "@/components/FinanceImportView";

export default function FinanceImportPage() {
  return (
    <AdminGuard>
      <FinanceImportView />
    </AdminGuard>
  );
}
