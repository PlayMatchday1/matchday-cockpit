import PagePermissionGuard from "@/components/PagePermissionGuard";
import FakeLadderView from "@/components/FakeLadderView";

export default function FakeLadderPage() {
  return (
    <PagePermissionGuard page="matchops">
      <FakeLadderView />
    </PagePermissionGuard>
  );
}
