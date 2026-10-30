// POST /api/offers/photos { contentType, sizeBytes }: step 1 of a photo upload, a PUT link for the
// browser. Checked here before a link is asked for, and the link's host is checked before it is
// handed over (see photoLinkProblem in src/lib/offersServer.ts).

import { MAX_PHOTO_BYTES, photoContentType } from "@/lib/offersModel";
import { askPhotoLink, errorText, offersGate, photoLinkProblem, readJson, type PhotoLink } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const type = typeof raw.contentType === "string" ? photoContentType({ type: raw.contentType, name: "" }) : null;
  if (!type) return Response.json({ error: "Only JPG, PNG or WebP images can be uploaded." }, { status: 400 });
  const size = raw.sizeBytes;
  if (!Number.isInteger(size) || (size as number) <= 0 || (size as number) > MAX_PHOTO_BYTES) return Response.json({ error: "The image must be 5 MB or less." }, { status: 400 });
  let link: PhotoLink;
  try { link = await askPhotoLink(auth, type, size as number); } catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
  const problem = photoLinkProblem(link);
  if (problem) return Response.json({ error: problem }, { status: 502 });
  return Response.json(link);
}
