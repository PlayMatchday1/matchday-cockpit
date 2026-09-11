/* GET /api/veo/thumbs?ids=<id>,<id>,… — still frames for a LIST of recordings, in one round trip.
 * READ ONLY. Writes nothing, touches no recording, and cannot post.
 *
 * WHY A SECOND ROUTE RATHER THAN N CALLS TO /api/veo/thumb. The queue list renders up to 30 rows
 * and every row now carries a poster. One request per row is 30 browser requests and 30 serverless
 * invocations for one screen. This is one request and one invocation, and the scrapes inside it run
 * in parallel.
 *
 * WHAT IT COSTS, AND IT IS NOT FREE. veo_recordings has NO thumbnail column — measured, the full
 * column list is id, recording_id, match_path_slug, video_url, email_subject, … and nothing
 * resembling a still frame. The URL only exists in the og:image of the recording page on
 * app.veo.co, so a first-time poster is an external page fetch per recording. That is why this
 * route caches for six hours, why it fetches in parallel rather than in series, and why the LIST
 * does not wait for it: RecentlyUploaded renders the rows first and fills the posters in after.
 *
 * IT IS A SEPARATE CACHE FROM /api/veo/thumb's, DELIBERATELY. That route is unchanged — it is on
 * the "must not change" list, and a suite imports videoFromThumb out of it. Two per-instance caches
 * of the same immutable data cost one extra scrape per recording per instance and nothing else;
 * merging them would mean editing a route this change was told to leave alone.
 *
 * The host guards are the originals': the recording is looked up BY ID and its stored video_url is
 * used, never a URL from the request, and the parsed host must equal app.veo.co — a substring test
 * would let "app.veo.co.evil.example" through.
 */

import { authenticateCrm } from "@/lib/crmAuth";
import { videoFromThumb } from "../thumb/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const cache = new Map<string, { url: string | null; video: string | null; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

const OG = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i;

/* A CEILING ON THE FAN-OUT. The list asks for what it is showing, but the id list arrives in a
 * query string and this route must not be turnable into a scraper by lengthening it. */
const MAX_IDS = 40;

async function scrapeOne(videoUrl: string | null): Promise<{ url: string | null; video: string | null }> {
  if (!videoUrl) return { url: null, video: null };
  let host = "";
  try { host = new URL(videoUrl).host; } catch { return { url: null, video: null }; }
  if (host !== "app.veo.co") return { url: null, video: null };
  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = OG.exec(html);
    const url = m && /^https:\/\/[a-z0-9.-]*veocdn\.com\//i.test(m[1]) ? m[1] : null;
    return { url, video: url ? videoFromThumb(url) : null };
  } catch {
    /* A MISSING POSTER IS NOT AN ERROR THE OPERATOR CAN ACT ON. The row renders its empty box and
     * stays exactly the same height — see the note on .qpo. One slow recording must not take the
     * whole batch down, which is why this is caught per id rather than around the Promise.all. */
    return { url: null, video: null };
  }
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return Response.json({ thumbs: {} });

  const out: Record<string, { thumbnail: string | null; video: string | null }> = {};
  const need: string[] = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) out[id] = { thumbnail: hit.url, video: hit.video };
    else need.push(id);
  }

  if (need.length > 0) {
    const { data, error } = await auth.supabase
      .from("veo_recordings").select("id, video_url").in("id", need);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    const byId = new Map((data ?? []).map((r) => [String(r.id), (r.video_url as string | null) ?? null]));
    const results = await Promise.all(
      need.map(async (id) => [id, await scrapeOne(byId.get(id) ?? null)] as const),
    );
    for (const [id, r] of results) {
      cache.set(id, { url: r.url, video: r.video, at: Date.now() });
      out[id] = { thumbnail: r.url, video: r.video };
    }
  }

  return Response.json({ thumbs: out, scraped: need.length, cached: ids.length - need.length },
    { headers: { "Cache-Control": "no-store" } });
}
