// POST /api/pushes/audience: how many players match the filters (or the pasted list) right now, how many allow
// pushes and how many would be held back; with { sample: true }, a sample of who they are ("See players"). Reads
// the backend takes as POSTs; see readPushCount / readPushSample in src/lib/pushesServer.ts.

import type { AudienceBody, FilterBody } from "@/lib/audienceModel";
import { offersGate, readJson } from "@/lib/offersServer";
import { fixtureOn, pushesErrorText, readPushCount, readPushSample } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

function audienceOf(raw: Record<string, unknown>): AudienceBody | null {
  if (raw.audienceMode === "PLAYERS") {
    const ids = Array.isArray(raw.playerIds) ? raw.playerIds.filter((x) => Number.isInteger(x) && (x as number) > 0) as number[] : [];
    return { audienceMode: "PLAYERS", playerIds: ids };
  }
  if (raw.audienceMode === "FILTERS") return { audienceMode: "FILTERS", filters: Array.isArray(raw.filters) ? (raw.filters as FilterBody[]) : [] };
  return null;
}

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = audienceOf(raw);
  if (!body) return Response.json({ error: "Send audienceMode FILTERS with filters, or PLAYERS with playerIds." }, { status: 400 });
  try {
    return Response.json({ ...(raw.sample === true ? await readPushSample(auth, body) : await readPushCount(auth, body)), fixture: fixtureOn() });
  } catch (e) {
    return Response.json({ error: pushesErrorText(e) }, { status: 502 });
  }
}
