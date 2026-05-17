// Server-side helpers for the private `crm-media` Supabase Storage
// bucket. The bucket is provisioned out-of-band (Supabase dashboard)
// with a single SELECT RLS policy gated on app_users.is_admin = true.
// All writes here use the service role so RLS is bypassed; reads on
// behalf of the cockpit use short-lived signed URLs minted per
// request.
//
// Path scheme: {threadId}/{messageId}/{sanitizedFilename}
// - threadId first so a per-thread prefix list works.
// - messageId second so the row's id is the canonical reference.
// - filename last for human inspection in the dashboard.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "crm-media";
const DEFAULT_SIGNED_URL_TTL_S = 600; // 10 minutes

function getServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "crm-media: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Limited MIME-to-extension table — covers the inbound WhatsApp image
// MIME types Meta sends today. Add entries as PRs introduce more
// types.
function extFromMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "bin";
}

// Strip path components, replace anything outside [A-Za-z0-9._-] with
// underscores, cap length, fall back to "attachment.{ext}" when the
// incoming name is null or unusable. Result is safe to use directly
// in a Storage object key.
function sanitizeFilename(
  name: string | null | undefined,
  mimeType: string,
): string {
  if (!name || !name.trim()) {
    return `attachment.${extFromMime(mimeType)}`;
  }
  const stripped = name.replace(/.*[\\/]/, "").trim();
  const safe = stripped.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe.slice(0, 120) || `attachment.${extFromMime(mimeType)}`;
}

export type UploadMessageMediaArgs = {
  threadId: string;
  messageId: string;
  buffer: Buffer;
  mimeType: string;
  filename?: string | null;
};

// Uploads the media bytes to crm-media and returns the Storage path
// (NOT a URL). The path is what gets stored on crm_messages.media_url
// and what getSignedMediaUrl consumes to mint per-request URLs.
//
// upsert: false so a replay of the same message (same messageId) does
// not silently overwrite an earlier upload. Replay dedupe at the
// crm_messages level (23505 on external_message_id) already prevents
// duplicate inserts, but defending here too keeps the Storage state
// consistent if the dedupe gets reordered.
export async function uploadMessageMedia({
  threadId,
  messageId,
  buffer,
  mimeType,
  filename,
}: UploadMessageMediaArgs): Promise<string> {
  const sb = getServiceRoleClient();
  const safeName = sanitizeFilename(filename, mimeType);
  const path = `${threadId}/${messageId}/${safeName}`;

  const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) {
    throw new Error(`crm-media upload failed (${path}): ${error.message}`);
  }
  console.log(
    `[crmMedia] uploaded path=${path} bytes=${buffer.length} mime=${mimeType}`,
  );
  return path;
}

// Mints a short-lived signed URL for the given storage path. Caller
// supplies the Supabase client so authed routes can reuse the
// request's JWT (RLS policy passes for admin users) and webhook
// callers can pass the service role client.
export async function getSignedMediaUrl(
  supabase: SupabaseClient,
  storagePath: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_S,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    console.error(
      `[crmMedia] signed URL failed for ${storagePath}:`,
      error?.message ?? "no signedUrl in response",
    );
    return null;
  }
  return data.signedUrl;
}
