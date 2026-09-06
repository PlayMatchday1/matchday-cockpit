/* GET /api/veo/thumb?id=<veo_recordings.id> — the film's still frame AND the film. READ ONLY.
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
 * AND THE FILM ITSELF, WHICH IS NOT BEHIND THE IFRAME REFUSAL. The embed conclusion above is
 * unchanged and unrevisited — no iframe will ever work. But the mp4 sits in the SAME CDN folder as
 * the still frame, under a different filename, and it is public and unauthenticated. Measured on
 * three real films today:
 *
 *     video.mp4    HEAD 200 · content-type video/mp4 · accept-ranges: bytes
 *                  content-length 1.65 GB, 1.97 GB, 2.00 GB
 *                  Range: bytes=0-1023 → 206 with a correct content-range
 *     index.m3u8   403 — HLS is gated, so the progressive mp4 is the one that works
 *
 * RANGES ARE SUPPORTED, so a <video> seeks without downloading two gigabytes first, and the
 * browser fetches only what it plays. There is no access-control-allow-origin header, which is
 * fine for playback — a media element loads cross-origin without CORS — but it does mean the
 * element must NOT set `crossorigin`, and nothing can read pixels back out of it.
 *
 * ON EXPOSURE. The folder id comes from the og:image on the recording page, and that page is the
 * link we already post into the match chat. Anyone holding the link the players got can derive the
 * same mp4. THIS ADDS NO EXPOSURE THE POSTED LINK DID NOT ALREADY CARRY. The film also streams
 * from Veo's CDN straight to the operator's browser, so none of it crosses our egress.
 *
 * IT RETURNS URLs, NOT BYTES. Proxying a 2GB film — or even 280KB of JPEG — through a serverless
 * function would be slower and would put our egress in front of a CDN built for this.
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
const cache = new Map<string, { url: string | null; video: string | null; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

const OG = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i;

/* THE FILM SITS BESIDE THE STILL FRAME. Same folder, filename swapped. Returns null rather than
 * guessing: the panel then keeps the thumbnail and the Open in Veo link, which is what shipped
 * before this.
 *
 * THE HOST CHECK IS ON THE PARSED HOST, never on a substring, for the same reason every other host
 * guard in this codebase is — "c.veocdn.com.evil.example" contains "c.veocdn.com" and must not
 * pass. */
export function videoFromThumb(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.host !== "c.veocdn.com") return null;
  if (!/\/thumbnail\.jpg$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/thumbnail\.jpg$/, "video.mp4")}`;
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json({ thumbnail: hit.url, video: hit.video });

  const { data, error } = await auth.supabase
    .from("veo_recordings").select("video_url").eq("id", id).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const videoUrl = (data?.video_url as string | null) ?? null;
  if (!videoUrl) return Response.json({ thumbnail: null, video: null });

  // HOST-GUARDED ON THE PARSED HOST, never on a substring — "app.veo.co.evil.com" must not pass.
  let host = "";
  try { host = new URL(videoUrl).host; } catch { return Response.json({ thumbnail: null, video: null }); }
  if (host !== "app.veo.co") return Response.json({ thumbnail: null, video: null });

  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = OG.exec(html);
    const url = m && /^https:\/\/[a-z0-9.-]*veocdn\.com\//i.test(m[1]) ? m[1] : null;
    // ONE SCRAPE, BOTH URLs. A second round trip for the film would double the work for a page
    // that opens rows one after another.
    const video = url ? videoFromThumb(url) : null;
    cache.set(id, { url, video, at: Date.now() });
    return Response.json({ thumbnail: url, video });
  } catch (e) {
    // A missing thumbnail is not an error the operator can act on — the panel shows its placeholder
    // and the Open in Veo button, which is the whole of what the viewer can do anyway.
    console.error("[veo:thumb]", e);
    return Response.json({ thumbnail: null, video: null });
  }
}
