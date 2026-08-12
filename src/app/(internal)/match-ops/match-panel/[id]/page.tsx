// Phase 23 Step 1 — host for the one-panel match editor. Always PRODUCTION (no env badge/toggle —
// the badge confused people; it is the only environment this panel edits).
import MatchPanel from "@/components/MatchPanel";

export default async function MatchPanelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="p-4">
      <MatchPanel matchId={id} env="production" />
    </div>
  );
}
