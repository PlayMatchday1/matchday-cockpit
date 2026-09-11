"use client";

// VC Outreach — the third kanban over the shared engine, beside Field Pipeline in Growth.
//
// NO PagePermissionGuard HERE. GrowthShell holds it for the whole section, so a new Growth page
// cannot ship ungated by forgetting a wrapper.
//
// AND THE PAGE GATE IS NOT THE BOUNDARY. kanban_cards RLS shipped as
// `FOR ALL TO authenticated USING (true)` — every signed-in account could read every card straight
// off PostgREST, whatever the page said. That is survivable for venues we are chasing; it is not
// for 90 firms carrying target round, check sizes and named partners. Migration 0166 scopes the
// policy by board_type against the reader's capability, keyed on EMAIL out of the JWT because
// app_users.id is not auth.uid() — 16 of 17 rows differ, measured.

import VcOutreachBoard from "@/components/VcOutreachBoard";

export default function VcOutreachPage() {
  return <VcOutreachBoard />;
}
