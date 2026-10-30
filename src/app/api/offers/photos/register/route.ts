// POST /api/offers/photos/register { fileKey }: step 3 of a photo upload. Answers { verdict, url }.

import { offersGate, readJson, registerPhoto } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  if (typeof raw.fileKey !== "string" || !raw.fileKey) return Response.json({ error: "No upload to register." }, { status: 400 });
  return registerPhoto(auth, raw.fileKey);
}
