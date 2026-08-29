/* FIELD PHOTOS — the /files broker contract, the S3 host guard, and the FOUR-STATE verdict.
 *
 * ── THE ENDPOINT NOBODY COULD FIND ────────────────────────────────────────────────────────────
 * Four targeted probes returned 404: /admin/fields/{id}/images, /admin/images,
 * /admin/fields/images, /admin/upload. All four were wrong in the same way — they assumed a FIELD
 * endpoint. It is not one. The reference implementation (retool-export-prod.json, queries
 * getUploadedUrlField / getUploadedUrlFieldCover) posts to a generic broker:
 *
 *     POST {api}/files      Authorization: Bearer …
 *     { contentType, entity: "field", entityContent: "cover" | "gallery", entityId: <fieldId> }
 *  -> { uploadURL }                                    <- staging returns THIS KEY AND NO OTHER
 *
 * The entity is a BODY PARAMETER, which is why no path containing "field" could ever have hit it.
 *
 * ── THE PUT IS PRESIGNED AND CARRIES NO CREDENTIAL OF OURS ────────────────────────────────────
 * uploadURL is SigV4 with X-Amz-Expires=3000 and X-Amz-SignedHeaders=host — only `host` is
 * signed, so no request header has to match and no Authorization may be sent. The object tag that
 * drives the attach rides in the SIGNED query string as `x-amz-tagging=field%3D<id>%26image%3D<kind>`.
 *
 * Retool also sends an `x-amz-tagging` REQUEST header sourced from
 * `getUploadedUrlField.data.header['x-amz-tagging']`. That path does not exist in the response —
 * staging returns `{uploadURL}` alone — so Retool sends an empty header and the tagging works
 * anyway, from the URL. We do not send it. (Production's response shape is UNKNOWN: probing it
 * would be a non-GET against production.)
 *
 * ── THE ATTACH IS ASYNCHRONOUS, AND THAT IS THE WHOLE DIFFICULTY ──────────────────────────────
 * POST /files creates NO row — measured. The PUT deposits bytes. The server then attaches the
 * image off the object tag, and only THEN does `images[]` gain a row or `cover` move. Measured on
 * staging 2026-08-29: the row appeared 1,551 ms after the PUT returned 200.
 *
 * So a 2xx is not the write landing, and an immediate read-back reports NOT APPLIED for a write
 * that is about to succeed. Hence a bounded poll and a state the synchronous writes do not have.
 */

export type PhotoKind = "cover" | "gallery";

/** LANDED   the read-back shows it — the only state that claims success.
 *  PENDING  the bytes are in S3, the attach has not appeared inside the window. NOT a failure:
 *           nothing is lost and it may still land. The user is told to refresh, not that it broke.
 *  FAILED   a call returned an error. Nothing was uploaded, or the delete was refused.
 *  UNKNOWN  we could not tell — a throw mid-flight, a read-back that itself failed. */
export type PhotoVerdict = "LANDED" | "PENDING" | "FAILED" | "UNKNOWN";

/* THE WINDOW. 8 seconds, polled every 500 ms.
 *
 * WHY 8s: the one measurement we have is 1,551 ms on staging, and there is NO CONTRACT saying the
 * attach is bounded at all — it is an S3-event side effect nobody documented. 8s is ~5x the
 * measured latency, which absorbs a production path that is several times slower, and it stays
 * far inside the route's 60s budget so the poll can never be the thing that times out.
 *
 * WHY NOT LONGER: past a few seconds the operator is staring at a spinner for a write that has
 * already succeeded in the only place that can lose data (S3). PENDING with an honest sentence is
 * better than a longer wait, because PENDING is TRUE — and the page's own Refresh resolves it. */
export const ATTACH_POLL_MS = 8000;
export const ATTACH_POLL_INTERVAL_MS = 500;

/** The S3 bucket host per environment, read off the presigned URLs the API actually returned.
 *  Staging measured 2026-08-29; production read from `cover`/`images[].url` on 44 live fields. */
export const S3_HOSTS: Record<string, string> = {
  staging: "matchday-stage.s3.us-west-1.amazonaws.com",
  production: "playmatchday.s3.us-west-1.amazonaws.com",
};

export class UploadHostError extends Error {
  constructor(host: string, expected: string) {
    super(`Refusing to PUT to ${JSON.stringify(host)} — expected ${JSON.stringify(expected)}.`);
    this.name = "UploadHostError";
  }
}

/* HOST-GUARDED ON THE PARSED HOST, never on a substring of the string.
 *
 * This URL comes back from an upstream response, which makes it exactly the kind of value the
 * standing rule is about: `…amazonaws.com.evil.com` must be rejected, and it is, because
 * new URL().host is the whole authority and the comparison is equality. A URL that will not parse
 * is refused rather than passed through. */
export function assertUploadHost(uploadUrl: string, env: string): URL {
  const expected = S3_HOSTS[env];
  if (!expected) throw new UploadHostError("<no host table>", `a known env, got ${JSON.stringify(env)}`);
  let u: URL;
  try { u = new URL(uploadUrl); } catch { throw new UploadHostError("<unparseable>", expected); }
  if (u.protocol !== "https:") throw new UploadHostError(`${u.protocol}//${u.host}`, `https://${expected}`);
  if (u.host !== expected) throw new UploadHostError(u.host, expected);
  return u;
}

/** The POST /files body. Written once so the four spellings of entityContent cannot drift. */
export function filesRequestBody(kind: PhotoKind, fieldId: number, contentType: string) {
  return { contentType, entity: "field", entityContent: kind, entityId: fieldId };
}

/* WHAT COUNTS AS ATTACHED, per kind — and it is deliberately keyed on the OBJECT KEY, not on a
 * count. "the gallery grew by one" is wrong the moment two uploads race or another operator is
 * working, and "cover changed" is wrong if the same bytes were re-uploaded. The key is the one
 * thing unique to this upload. */
export function attachedNow(kind: PhotoKind, objectKey: string,
  field: { cover?: string | null; images?: { id: number; url: string }[] | null } | null): boolean {
  if (!field) return false;
  if (kind === "cover") return typeof field.cover === "string" && field.cover.includes(objectKey);
  return (field.images ?? []).some((i) => String(i.url).includes(objectKey));
}

/** The last path segment of the presigned URL — the S3 object key, which is the uuid the attached
 *  row's `url` will end with. */
export const objectKeyOf = (u: URL): string => u.pathname.split("/").filter(Boolean).pop() ?? "";

/* THE SENTENCE THE OPERATOR READS. PENDING must never look like a failure and must never look
 * like a success: the bytes are safe, the record has not caught up, and refreshing is the action. */
export function verdictLine(v: PhotoVerdict, kind: PhotoKind, detail?: string): string {
  const what = kind === "cover" ? "Cover" : "Photo";
  switch (v) {
    case "LANDED": return `LANDED — ${what.toLowerCase()} uploaded and attached (read-back confirmed).`;
    case "PENDING": return `Uploaded. Not attached yet — refresh in a moment. The image is stored; the field record has not caught up (it usually takes a second or two).`;
    case "FAILED": return `FAILED — nothing was uploaded.${detail ? ` ${detail}` : ""}`;
    default: return `UNKNOWN — ${detail ?? "the outcome could not be read"}. Refresh before trying again.`;
  }
}

/* ── WHAT THIS MODEL DOES NOT DO, and why ─────────────────────────────────────────────────────
 *
 * NO "MAKE THIS PHOTO THE COVER". PUT /admin/fields/{id} (Retool's `updateField`) has no `cover`
 * key in its body — title, description, parkingNote, address, zipcode, lat, lng, cityId,
 * recommendedPlayerCount, abbr, orderPosition and nothing else. A cover is set ONLY by uploading
 * one. Promoting an existing gallery photo is not an operation the API has.
 *
 * NO DELETE-COVER. Every query in the export was searched: the only image delete is
 * deleteImageFromField, DELETE /admin/fields/{id}/images?imageId[]={id}, and it acts on gallery
 * rows. There is no cover equivalent, so the cover control is REPLACE-ONLY.
 *
 * COVER AND GALLERY ARE DISJOINT SETS, so the page renders them as two separate controls and says
 * nothing about overlap. Measured on all 44 production fields: 44 have a cover, 33 have gallery
 * photos, and the cover URL appears inside images[] ZERO times. (Positive control in the same
 * pass: a gallery URL does match itself, so the comparison was capable of finding an overlap.)
 */
