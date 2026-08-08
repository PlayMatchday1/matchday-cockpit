"use client";
// Roster editor page (Phase 13). Reads LIVE from the guarded production route and
// edits the roster with a diff plan + one-at-a-time, read-back-confirmed save.
import { use } from "react";
import RosterEditor from "@/components/RosterEditor";

export default function RosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RosterEditor matchId={Number(id)} />;
}
