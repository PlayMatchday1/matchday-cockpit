// GET and PUT /api/offers/push-settings { weeklyCap }: the shared limit on marketing pushes per player in any
// 7 days (0 to 14; 0 stops them all). A write: logged, staff header, LANDED when the answer holds the new limit.

import { CAP_MAX, CAP_MIN } from "@/lib/offersPush";
import { errorText, offersGate, pushNotFound, pushesAllowed, readJson, readPushSettings, savePushSettings } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  if (!pushesAllowed(auth)) return pushNotFound();
  try { return Response.json(await readPushSettings()); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}

export async function PUT(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  if (!pushesAllowed(auth)) return pushNotFound();
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const n = raw.weeklyCap;
  if (!Number.isInteger(n) || (n as number) < CAP_MIN || (n as number) > CAP_MAX) return Response.json({ error: `The limit is a whole number from ${CAP_MIN} to ${CAP_MAX}.` }, { status: 400 });
  return savePushSettings(auth, n as number);
}
