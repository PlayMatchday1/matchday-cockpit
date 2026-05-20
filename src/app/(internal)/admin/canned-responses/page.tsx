import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import CannedResponsesAdminView from "@/components/CannedResponsesAdminView";
import PageHeader from "@/components/PageHeader";

export default function CannedResponsesAdminPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · Canned responses"
        subtitle="Curate reusable text + image templates for the /chats Composer picker."
      />
      <AdminSubNav active="canned-responses" />
      <CannedResponsesAdminView />
    </AdminGuard>
  );
}
