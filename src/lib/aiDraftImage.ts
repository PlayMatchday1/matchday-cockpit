import "server-only"; // no-op under --conditions=react-server
// A PLAYER'S IMAGE, READY FOR THE MODEL. Read from the private crm-media bucket, turned the right way up,
// long edge 1024 pixels at most, re-encoded as JPEG, which also drops EXIF (a phone photo's location).
// The bytes go in the request and nowhere else: not crm_ai_drafts, not a log.

import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadMessageMedia } from "@/lib/crmMedia";
import type { DraftImage } from "@/lib/aiDraftModel";

export const IMAGE_LONG_EDGE = 1024;

// Loaded here rather than at the top: it's a native module, and if it ever failed to load, that should
// cost one image going to a person, not every draft and the tick.
export async function downscaleForModel(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: IMAGE_LONG_EDGE, height: IMAGE_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function loadDraftImage(sb: SupabaseClient, messageId: string, storagePath: string): Promise<DraftImage | null> {
  try {
    const raw = await downloadMessageMedia(sb, storagePath);
    if (!raw) return null;
    return { messageId, mediaType: "image/jpeg", data: (await downscaleForModel(raw)).toString("base64") };
  } catch (e) {
    console.error("[ai-draft] image not loaded", messageId, e instanceof Error ? e.message.slice(0, 120) : "error");
    return null;
  }
}
