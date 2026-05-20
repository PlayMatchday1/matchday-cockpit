// Server-side helpers for the canned-response-images Supabase
// Storage bucket. Mirrors src/lib/crmMedia.ts — service-role upload,
// service-role/anon signed-URL minting via the route's supabase
// client.
//
// Path scheme: {responseId}/{sanitizedFilename}. responseId first so
// the row's id is the canonical reference and per-template prefix
// listing works in the Supabase dashboard.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const CANNED_RESPONSE_BUCKET = "canned-response-images";
const DEFAULT_SIGNED_URL_TTL_S = 3600; // 1 hour, per spec

function getServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "canned-response-images: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function extFromMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "bin";
}

function sanitizeFilename(
  name: string | null | undefined,
  mimeType: string,
): string {
  if (!name || !name.trim()) {
    return `image.${extFromMime(mimeType)}`;
  }
  const stripped = name.replace(/.*[\\/]/, "").trim();
  const safe = stripped.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe.slice(0, 120) || `image.${extFromMime(mimeType)}`;
}

export type UploadCannedResponseImageArgs = {
  responseId: string;
  buffer: Buffer;
  mimeType: string;
  filename?: string | null;
};

// Uploads to canned-response-images and returns the Storage path
// (stored on crm_canned_responses.image_path). upsert=false so
// re-uploads with the same filename for the same row don't silently
// overwrite — the admin UI deletes the old object before uploading
// a replacement.
export async function uploadCannedResponseImage({
  responseId,
  buffer,
  mimeType,
  filename,
}: UploadCannedResponseImageArgs): Promise<string> {
  const sb = getServiceRoleClient();
  const safeName = sanitizeFilename(filename, mimeType);
  const path = `${responseId}/${safeName}`;
  const { error } = await sb.storage
    .from(CANNED_RESPONSE_BUCKET)
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,
    });
  if (error) {
    throw new Error(
      `canned-response-images upload failed (${path}): ${error.message}`,
    );
  }
  console.log(
    `[crmCannedResponses] uploaded path=${path} bytes=${buffer.length} mime=${mimeType}`,
  );
  return path;
}

// Removes the object from storage. Best-effort — caller should log
// but not throw on failure (an orphan object is benign; a thrown
// error would block the DB delete and surface a confusing error).
export async function deleteCannedResponseImage(
  storagePath: string,
): Promise<void> {
  const sb = getServiceRoleClient();
  const { error } = await sb.storage
    .from(CANNED_RESPONSE_BUCKET)
    .remove([storagePath]);
  if (error) {
    console.error(
      `[crmCannedResponses] storage delete failed for ${storagePath}:`,
      error.message,
    );
  }
}

// Mints a short-lived signed URL for the given storage path. Caller
// passes the request's supabase client (admin RLS already passed at
// the route boundary).
export async function getSignedCannedResponseUrl(
  supabase: SupabaseClient,
  storagePath: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_S,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(CANNED_RESPONSE_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    console.error(
      `[crmCannedResponses] signed URL failed for ${storagePath}:`,
      error?.message ?? "no signedUrl in response",
    );
    return null;
  }
  return data.signedUrl;
}
