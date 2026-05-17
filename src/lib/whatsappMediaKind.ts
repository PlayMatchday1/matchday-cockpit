// Pure MIME → outbound media kind classifier. Shared between the
// Composer (client-side picker validation, immediate user feedback)
// and /api/crm/send-media (server-side enforcement). Lives outside
// server-only so the client bundle can import it; carries no
// credentials or API endpoints.
//
// WhatsApp Cloud API outbound constraints (Meta docs v21.0):
//   image      JPEG, PNG up to 5 MB
//   video      MP4, 3GPP up to 16 MB (rejects QuickTime / .mov)
//   audio      AAC, MP3, MP4, AMR, OGG up to 16 MB (NO captions)
//   document   broad MIME up to 100 MB
//
// Sticker outbound is not supported in v1 — only inbound stickers
// (rendered by PR #65).

export type OutboundMediaKind = "image" | "video" | "audio" | "document";

export const MEDIA_BYTE_LIMITS: Record<OutboundMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

const ALLOWED_IMAGE = new Set(["image/jpeg", "image/png"]);
const ALLOWED_VIDEO = new Set(["video/mp4", "video/3gpp"]);
const ALLOWED_AUDIO = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/amr",
  "audio/ogg",
]);

// Comma-separated string for <input type="file" accept=...>. Covers
// the common Office + iWork + plain-text + archive document MIMEs
// alongside the strict image/video/audio lists. The picker is
// hint-only; the classifier below is the source of truth.
export const COMPOSER_ACCEPT_ATTR = [
  // image
  "image/jpeg",
  "image/png",
  // video
  "video/mp4",
  "video/3gpp",
  // audio
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
  // documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
].join(",");

export type ClassifyResult =
  | { ok: true; kind: OutboundMediaKind }
  | { ok: false; error: string };

export function classifyOutboundMime(mime: string): ClassifyResult {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();

  // iOS Photos exports videos as QuickTime by default — operators
  // try this constantly and Meta returns an unhelpful generic error.
  // Surface the conversion path here so they don't wonder.
  if (m === "video/quicktime" || m === "video/x-quicktime") {
    return {
      ok: false,
      error:
        "iOS videos must be MP4. Open the video in Photos, tap Share, choose Save as File, and select MP4. Or use a different video.",
    };
  }

  if (m.startsWith("image/")) {
    if (ALLOWED_IMAGE.has(m)) return { ok: true, kind: "image" };
    return { ok: false, error: "Images must be JPEG or PNG." };
  }
  if (m.startsWith("video/")) {
    if (ALLOWED_VIDEO.has(m)) return { ok: true, kind: "video" };
    return { ok: false, error: "Videos must be MP4 or 3GPP." };
  }
  if (m.startsWith("audio/")) {
    if (ALLOWED_AUDIO.has(m)) return { ok: true, kind: "audio" };
    return {
      ok: false,
      error: "Audio must be AAC, MP3, MP4, AMR, or OGG.",
    };
  }

  // Anything else — including empty MIME — falls through to document.
  // Meta accepts a broad range and will surface any rejection at
  // send time. This is permissive on purpose: an operator with a
  // PowerPoint, ZIP, or whatever shouldn't hit a wall here.
  return { ok: true, kind: "document" };
}

export function maxBytesFor(kind: OutboundMediaKind): number {
  return MEDIA_BYTE_LIMITS[kind];
}

export function bytesLimitLabel(kind: OutboundMediaKind): string {
  const mb = MEDIA_BYTE_LIMITS[kind] / (1024 * 1024);
  return `${mb} MB`;
}
