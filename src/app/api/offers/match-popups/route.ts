// GET /api/offers/match-popups: match id -> the in-app popups for it (src/lib/matchPopups.ts), for Match Promotion's
// Popup channel. One read of /admin/offers/page; nothing else crosses to the browser (id, name, state).

import { popupsByMatch } from "@/lib/matchPopups";
import { errorText, offersGate, readPage } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    const { campaigns } = await readPage();
    return Response.json({ byMatch: popupsByMatch(campaigns) });
  } catch (e) {
    return Response.json({ error: errorText(e) }, { status: 502 });
  }
}
