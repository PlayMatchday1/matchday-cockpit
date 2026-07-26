import { redirect } from "next/navigation";

// The Veo review queue + field-code editor moved to Cities → Field Ops → Veo.
// The real redirect is a routing-layer entry in next.config.ts (a proper HTTP
// 307 before any layout renders). This page is a kept fallback so the route is
// never deleted outright — if the config redirect were ever removed, a hard
// load here still lands on the Veo tab.
export default function VeoAdminRedirect() {
  redirect("/cities?tab=fields&fo=veo");
}
