import MatchRenameEditor from "./MatchRenameEditor";

// Deliberately plain staging match page: read-only identity + one editable field
// (the name). Every write goes through the host-guarded staging client, so this
// page physically cannot touch production.
export const dynamic = "force-dynamic";

export default async function StageMatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MatchRenameEditor id={id} />;
}
