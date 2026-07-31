"use client";

// Review — First-Match Review, relocated from /admin/first-match-review to
// Match Ops. Same component (FirstMatchReviewView), same query, same data. The
// AdminGuard (is_admin) moves WITH it and is NOT loosened — the move does not
// widen who can open it. The AdminSubNav is intentionally not rendered here
// (this page is no longer in the admin section); the rail is the nav now.

import AdminGuard from "@/components/AdminGuard";
import FirstMatchReviewView from "@/components/FirstMatchReviewView";
import PageHeader from "@/components/PageHeader";

export default function ReviewPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="First-Match Review"
        subtitle="Repeat first-match promo claims flagged for review — same phone or email across multiple accounts."
      />
      <FirstMatchReviewView />
    </AdminGuard>
  );
}
