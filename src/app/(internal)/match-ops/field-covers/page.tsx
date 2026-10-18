// FIELD COVERS (LOCAL) — /match-ops/field-covers. LOCAL MODE ONLY: a 404 everywhere else, including production.
//
// WHY THIS PAGE EXISTS. The two real homes of the cover controls, the Fields drawer and the Gameday Ops match
// panel, read production (the MatchDay API and production Supabase mirrors) and refuse to load in local mode, and
// pointing them at seed data would mix seed ids with production rows. So this page hosts the SAME two components
// (FieldCoversSection, MatchCoverField) against the local backend, for building and checking them. It is not a
// third place to manage covers and is not linked from the nav.
import { notFound } from "next/navigation";
import { localModeOn } from "@/lib/localMode";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldCoversLocal from "./FieldCoversLocal";

export const dynamic = "force-dynamic";

export default function FieldCoversLocalPage() {
  if (!localModeOn()) notFound();
  return (
    <PagePermissionGuard page="matchops">
      <FieldCoversLocal />
    </PagePermissionGuard>
  );
}
