import AdminGuard from "@/components/AdminGuard";
import AdminSubNav from "@/components/AdminSubNav";
import FirstMatchReviewView from "@/components/FirstMatchReviewView";
import PageHeader from "@/components/PageHeader";

export default function FirstMatchReviewPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="Admin · First-Match Review"
        subtitle="Repeat first-match promo claims flagged for review — same phone or email across multiple accounts."
      />
      <AdminSubNav active="first-match-review" />
      <FirstMatchReviewView />
    </AdminGuard>
  );
}
