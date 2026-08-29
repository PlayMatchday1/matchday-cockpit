/* FIELD PHOTOS — the only write path for a field's cover or gallery.
 *
 *   POST   /api/fields/photos?id=&kind=cover|gallery   multipart `file`  -> upload
 *   DELETE /api/fields/photos?id=&imageId=                                -> remove a gallery photo
 *
 * THE FLOW, and every step of it was measured rather than read off the mockup:
 *
 *   1. POST {api}/files  { contentType, entity:"field", entityContent:kind, entityId:id }
 *      -> { uploadURL }.  Creates NO row. Authenticated with our Bearer token.
 *   2. PUT uploadURL, raw bytes.  PRESIGNED — no Authorization, and the object tag that drives
 *      the attach is already in the signed query string. HOST-GUARDED on the parsed host.
 *   3. The server attaches the image asynchronously off that tag. ~1,551 ms on staging.
 *   4. We poll the field list for the OBJECT KEY until it appears or the window expires.
 *
 * THE PUT IS SERVER-SIDE, deliberately. Sending the browser straight at S3 would need bucket CORS
 * (the PUT response carries no Access-Control-Allow-Origin, so it would be blocked), and it would
 * put the one irreversible step outside the host guard, outside recordWrite and outside the
 * verdict. Bytes go browser -> here -> S3.
 *
 * FOUR STATES, NOT THE USUAL FOUR. Synchronous writes report LANDED / FAILED / NOT APPLIED /
 * UNKNOWN. This one cannot: "not applied" is a claim about the end state, and the end state is
 * still arriving. It reports LANDED / PENDING / FAILED / UNKNOWN, and PENDING is true rather than
 * hedged — the bytes are in S3 and the record has not caught up.
 *
 * ORPHANS ARE POSSIBLE AND ARE NOT CLEANED UP HERE. If the attach never happens the S3 object
 * exists with nothing referencing it. We cannot see it: the only list we can read is the field's
 * `images[]`, which is by definition the attached ones. There is no bucket-listing endpoint in the
 * API surface, so an orphan is invisible from our side and this route does not pretend otherwise —
 * it reports PENDING and stops. See docs/matchday-api-facts.md.
 *
 * WHO: EDIT MATCHES, enforced by apiWrite's own guard, which is the unbypassable chokepoint. A
 * field's photos are what a player sees before they pay to play on it.
 */

import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  assertUploadHost, objectKeyOf, filesRequestBody, attachedNow,
  ATTACH_POLL_MS, ATTACH_POLL_INTERVAL_MS, UploadHostError, type PhotoKind, type PhotoVerdict,
} from "@/lib/fieldPhotos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* THE ENVIRONMENT IS FIXED, not a parameter. This page edits production fields; letting a query
 * string choose the environment would let a staging upload be reported as a production one. */
const ENV = "production" as const;

/** THE ONLY TYPES ACCEPTED. An arbitrary content-type reaches S3 and then a player's browser. */
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;

type ApiField = { id: number; cover?: string | null; images?: { id: number; url: string }[] | null };

/** THERE IS NO SINGLE-FIELD GET — /admin/fields/{id} is a 404, measured. Every read-back re-fetches
 *  the list and finds the id, which is still a read-back. */
async function readField(id: number): Promise<ApiField | null> {
  const all = await apiGet<unknown>(ENV, "/admin/fields", { limit: 500 });
  const list = (Array.isArray(all) ? all : ((all as { data?: unknown[] })?.data ?? [])) as ApiField[];
  return list.find((f) => Number(f.id) === id) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const kind = url.searchParams.get("kind") as PhotoKind | null;
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "A numeric field id is required." }, { status: 400 });
  if (kind !== "cover" && kind !== "gallery") return Response.json({ error: 'kind must be "cover" or "gallery".' }, { status: 400 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch { /* handled below */ }
  if (!file) return Response.json({ error: "No file was received." }, { status: 400 });
  if (!ALLOWED.has(file.type)) {
    return Response.json({ error: `${file.type || "that file type"} is not accepted — JPEG, PNG or WebP.` }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 10 MB.` }, { status: 400 });
  }

  const actor = { canEditMatches: true, email: auth.email, userId: auth.appUserId };
  const before = await readField(id).catch(() => null);
  if (!before) return Response.json({ error: `Field ${id} was not found.` }, { status: 404 });

  // ── 1. ASK FOR A PRESIGNED URL. This creates nothing; it is not the write. ──
  let uploadUrl: string;
  try {
    const r = await apiWrite<{ uploadURL?: string }>(ENV, "POST", "/files",
      filesRequestBody(kind, id, file.type), actor);
    if (!r?.uploadURL) throw new Error("POST /files returned no uploadURL.");
    uploadUrl = r.uploadURL;
  } catch (e) {
    return Response.json({ verdict: "FAILED" satisfies PhotoVerdict, kind,
      error: `Couldn't get an upload URL: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  let parsed: URL;
  try { parsed = assertUploadHost(uploadUrl, ENV); }
  catch (e) {
    // A refused host is a 500 on OUR side, not the operator's fault, and nothing was uploaded.
    console.error("[field-photos] upload host refused", e instanceof UploadHostError ? e.message : e);
    return Response.json({ verdict: "FAILED" satisfies PhotoVerdict, kind,
      error: "The upload URL was not the expected S3 bucket. Nothing was uploaded." }, { status: 502 });
  }
  const key = objectKeyOf(parsed);

  /* ── 2-4. THE WRITE, THROUGH recordWrite. `write` is the S3 PUT; `readResource` is the field
   * read-back. `applied` polls, because the attach is asynchronous — without the poll every
   * successful upload would be logged as notapplied. The poll lives INSIDE applied so the
   * change_log outcome and the operator's verdict come from the same observation. */
  let putStatus = 0;
  let attached = false;
  let bytes: ArrayBuffer;
  try { bytes = await file.arrayBuffer(); }
  catch { return Response.json({ verdict: "UNKNOWN" satisfies PhotoVerdict, kind, error: "The file could not be read." }, { status: 400 }); }

  const { outcome, error, logged } = await recordWrite(
    {
      env: ENV, source: "Fields · photo upload", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: `Field ${id}`,
      method: "PUT", path: `s3://${parsed.host}/${key}`,
      // NEVER the bytes and never the signed URL — the signature is a bearer credential for 50
      // minutes. Only what a reviewer needs to identify the object.
      body: { field_id: id, kind, content_type: file.type, size_bytes: file.size, object_key: key },
      keys: [], label: (k) => k,
      changes: [{ key: `photo:${kind}`, field: kind === "cover" ? "Cover image" : "Photo",
        before: kind === "cover" ? (before.cover ?? "none") : `${(before.images ?? []).length} photos`,
        after: `uploaded ${key}` }],
      applied: () => attached,
    },
    {
      readResource: async () => ({ field: await readField(id) }),
      write: async () => {
        // NO AUTHORIZATION HEADER. The URL is presigned; adding one makes S3 refuse it.
        // WRITES NEVER RETRY: one PUT, and a non-2xx is a failure, not a prompt to try again.
        const res = await fetch(parsed.toString(), { method: "PUT", body: new Uint8Array(bytes) });
        putStatus = res.status;
        if (!res.ok) throw new Error(`S3 PUT ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        // THE BOUNDED POLL. See ATTACH_POLL_MS for why 8s.
        const deadline = Date.now() + ATTACH_POLL_MS;
        while (Date.now() < deadline) {
          const f = await readField(id).catch(() => null);
          if (attachedNow(kind, key, f)) { attached = true; break; }
          await sleep(ATTACH_POLL_INTERVAL_MS);
        }
        return { attached };
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error && putStatus === 0) {
    return Response.json({ verdict: "FAILED" satisfies PhotoVerdict, kind, logRecorded: logged, outcome,
      error: `The upload was refused: ${error.message}` }, { status: 502 });
  }
  if (error) {
    return Response.json({ verdict: "UNKNOWN" satisfies PhotoVerdict, kind, logRecorded: logged, outcome,
      error: error.message }, { status: 502 });
  }
  /* PENDING IS NOT A FAILURE. The bytes are in S3 and the attach may still land — so the status is
   * 200 and the sentence says exactly that. Returning an error code here would make the page paint
   * red for a write that is probably fine, which is the one thing this must not do. */
  const verdict: PhotoVerdict = attached ? "LANDED" : "PENDING";
  return Response.json({ verdict, kind, objectKey: key, logRecorded: logged, outcome, putStatus,
    waitedMs: attached ? undefined : ATTACH_POLL_MS });
}

/* DELETE — gallery only. There is no cover equivalent anywhere in the reference implementation,
 * so the cover control is replace-only and this refuses anything that is not a gallery row.
 * This one IS synchronous: the row is gone on the read-back or it is not. */
export async function DELETE(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const imageId = Number(url.searchParams.get("imageId"));
  if (!Number.isInteger(id) || !Number.isInteger(imageId)) {
    return Response.json({ error: "Numeric id and imageId are required." }, { status: 400 });
  }
  const before = await readField(id).catch(() => null);
  if (!before) return Response.json({ error: `Field ${id} was not found.` }, { status: 404 });
  if (!(before.images ?? []).some((i) => Number(i.id) === imageId)) {
    // Refused rather than sent: an id that is not on this field is either the cover (which has no
    // delete) or someone else's row.
    return Response.json({ error: `Image ${imageId} is not a gallery photo on field ${id}.` }, { status: 400 });
  }
  const actor = { canEditMatches: true, email: auth.email, userId: auth.appUserId };
  const gone = (f: ApiField | null) => !!f && !(f.images ?? []).some((i) => Number(i.id) === imageId);

  const { outcome, error, logged } = await recordWrite(
    {
      env: ENV, source: "Fields · photo delete", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: `Field ${id}`,
      method: "DELETE", path: `/admin/fields/${id}/images?imageId[]=${imageId}`,
      body: { field_id: id, image_id: imageId }, keys: [], label: (k) => k,
      changes: [{ key: "photo:delete", field: "Photo", before: `image ${imageId}`, after: "removed" }],
      applied: (_b, a) => gone((a as { field: ApiField | null }).field),
    },
    {
      readResource: async () => ({ field: await readField(id) }),
      write: () => apiWrite(ENV, "DELETE", `/admin/fields/${id}/images?imageId[]=${imageId}`, undefined, actor),
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error) {
    return Response.json({ verdict: "FAILED" satisfies PhotoVerdict, logRecorded: logged, outcome, error: error.message }, { status: 502 });
  }
  const after = await readField(id).catch(() => null);
  const verdict: PhotoVerdict = after == null ? "UNKNOWN" : gone(after) ? "LANDED" : "FAILED";
  return Response.json({ verdict, imageId, logRecorded: logged, outcome });
}
