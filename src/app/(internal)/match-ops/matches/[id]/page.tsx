import MatchEditor from "./MatchEditor";

// STAGING match editor (Phase 2). Read-only identity + editable fields across
// Match / Pricing / Spots / Automation. Every write goes through the host-guarded
// staging client and sends ONLY the changed fields, so it cannot touch production
// and cannot overwrite anything the user did not edit.
export const dynamic = "force-dynamic";

export default async function StageMatchPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  // STEP TWO OF A COPY arrives here with ?copyFrom=<sourceId>. It is an ORDINARY EDIT of a match
  // that now exists — the only difference is that the source's remaining fields are staged as
  // unsaved changes, so one Save carries what the nine-field create could not.
  const copyFrom = typeof sp.copyFrom === "string" && sp.copyFrom ? sp.copyFrom : null;
  return <MatchEditor id={id} sourceId={copyFrom} />;
}
