import MatchEditor from "./MatchEditor";

// STAGING match editor (Phase 2). Read-only identity + editable fields across
// Match / Pricing / Spots / Automation. Every write goes through the host-guarded
// staging client and sends ONLY the changed fields, so it cannot touch production
// and cannot overwrite anything the user did not edit.
export const dynamic = "force-dynamic";

export default async function StageMatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MatchEditor id={id} />;
}
