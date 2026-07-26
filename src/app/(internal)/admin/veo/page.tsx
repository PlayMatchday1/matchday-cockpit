import { redirect } from "next/navigation";

// The Veo review queue + field-code editor moved to Cities → Field Ops → Veo.
// Kept as a redirect so old bookmarks / saved links to /admin/veo still land in
// the right place instead of 404-ing.
//
// force-dynamic so redirect() fires per-request and returns a real HTTP 307.
// Without it Next statically prerenders the page and a hard load (bookmark)
// gets a 200 shell that only redirects via client JS.
export const dynamic = "force-dynamic";

export default function VeoAdminRedirect() {
  redirect("/cities?tab=fields&fo=veo");
}
