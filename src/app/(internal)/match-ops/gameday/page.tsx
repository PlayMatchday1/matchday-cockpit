"use client";
// Gameday Ops (Phase 15) — the live triage board. Reads matches for one day straight
// from the guarded production route and edits them in the shared Master Schedule drawer.
import GamedayBoard from "@/components/GamedayBoard";

export default function GamedayPage() {
  return <GamedayBoard />;
}
