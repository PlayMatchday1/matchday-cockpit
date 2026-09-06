/* GET /api/veo/thumb?id=<veo_recordings.id> — the film's still frame. READ ONLY.
 *
 * WHY THIS EXISTS AT ALL. app.veo.co cannot be embedded — measured today, verbatim:
 *
 *   x-frame-options: DENY
 *   content-security-policy: … frame-ancestors https://stage.controlcentre.ai.io
 *     https://controlcentre.ai.io app.veo.co https://www.veo.com
 *
 * Clubhouse is on neither list, so no iframe can work and no front-end effort changes that. The
 * brief's fallback is a thumbnail and an Open in Veo button, and "do not ship an empty black box".
 * A dark rectangle with a play glyph IS an empty black box. The recording page carries a real
 * still frame in its og:image (c.veocdn.com/…/thumbnail.jpg, public, HTTP 200), so this route
 * reads that one meta tag server-side and hands the client the URL.
 *
 * IT RETURNS A URL, NOT AN IMAGE. Proxying 280KB of JPEG through a serverless function per row
 * would be slower and would put our egress in front of a CDN built for this. The <img> loads
 * straight from c.veocdn.com.
 *
 * The recording is looked up BY ID and its stored video_url is used — the URL is never taken from
 * the request, so this cannot be pointed at an arbitrary host, and the host is checked besides.
 */

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// A still frame does not change once the film is processed, so a long TTL is free. Per-instance,
// which is the right grain: it is a cache, not a store.
const cache = new Map<string, { url: string | null; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

const OG = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json({ thumbnail: hit.url });

  const { data, error } = await auth.supabase
    .from("veo_recordings").select("video_url").eq("id", id).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const videoUrl = (data?.video_url as string | null) ?? null;
  if (!videoUrl) return Response.json({ thumbnail: null });

  // HOST-GUARDED ON THE PARSED HOST, never on a substring — "app.veo.co.evil.com" must not pass.
  let host = "";
  try { host = new URL(videoUrl).host; } catch { return Response.json({ thumbnail: null }); }
  if (host !== "app.veo.co") return Response.json({ thumbnail: null });

  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = OG.exec(html);
    const url = m && /^https:\/\/[a-z0-9.-]*veocdn\.com\//i.test(m[1]) ? m[1] : null;
    cache.set(id, { url, at: Date.now() });
    return Response.json({ thumbnail: url });
  } catch (e) {
    // A missing thumbnail is not an error the operator can act on — the panel shows its placeholder
    // and the Open in Veo button, which is the whole of what the viewer can do anyway.
    console.error("[veo:thumb]", e);
    return Response.json({ thumbnail: null });
  }
}
