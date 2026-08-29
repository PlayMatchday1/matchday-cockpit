import PagePermissionGuard from "@/components/PagePermissionGuard";
import LapsedSpotsView from "@/components/LapsedSpotsView";

export default function LapsedSpotsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <LapsedSpotsView />
    </PagePermissionGuard>
  );
}
