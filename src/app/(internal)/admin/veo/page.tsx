import { redirect } from "next/navigation";

// The Veo review queue + field-code editor moved to Cities → Field Ops → Veo.
// Kept as a redirect so old bookmarks / saved links to /admin/veo still land in
// the right place instead of 404-ing.
export default function VeoAdminRedirect() {
  redirect("/cities?tab=fields&fo=veo");
}
