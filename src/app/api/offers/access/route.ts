// GET /api/offers/access: may THIS caller use Growth › Offers? 200 { allowed: true } only when local
// mode is on, they are an admin and they are on OFFERS_ALLOWLIST (offersGate, the same gate as every
// other /api/offers/* route). Anyone else gets that gate's refusal. The list never leaves the server.

import { offersGate } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  return Response.json({ allowed: true });
}
