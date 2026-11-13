// Members — the Retool MEMBERSHIPS page, rebuilt. Match Ops › Daily Ops › Operations (Ryan, 2026-11-13).
//
// GUARDED ON `membership`, NOT `matchops`. Every read behind the page is /api/membership/members, which
// gates on the membership capability; a Match Ops viewer without it would get a page of 403s. The rail
// item carries the same access, so it is not drawn for them either. Writes carry their own grants.
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MembersView from "@/components/MembersView";

export default function MembersPage() {
  return (
    <PagePermissionGuard page="membership">
      <MembersView />
    </PagePermissionGuard>
  );
}
