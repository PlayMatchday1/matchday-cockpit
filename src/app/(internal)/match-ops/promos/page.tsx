import PromoCodes from "@/components/PromoCodes";

// Promo Codes (Phase 18b). The screen ships behind MANAGE PROMOS: the server routes enforce
// the grant on every request, and the nav only surfaces this section to holders. The client
// component shows a courtesy gate too, but the routes are the real boundary.
export default function PromosPage() {
  return <PromoCodes />;
}
