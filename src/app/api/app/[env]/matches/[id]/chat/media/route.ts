// Staff app: A PHOTO OR VIDEO INTO A MATCH CHAT, AS MATCHDAY (Ryan, 2026-11-06).
//
//   POST /api/app/{env}/matches/{id}/chat/media   multipart: file (image/* or video/*), and for a
//                                                  video thumbnail (image/jpeg), width, height,
//                                                  duration (seconds)
//
// The file goes where the player app puts its own (matchChats.ts: chat_media[/staging]/images or
// /videos, the thumbnail under /thumbnails, in the matchday-sc.appspot.com bucket, served by the
// same tokened download URL) and the message is the player app's own photo or video message
// (text null, image, messageType the mime, media {type, url, fileName, thumbnailUrl, width,
// height, duration, size}), so a player sees it exactly like a player-sent one. Audited as
// "[photo] file" / "[video] file"; then the players' "New message" push, one per burst.
//
// Same gate as the chat route (chatGate): Chats to read, SEND MESSAGES to write, the live match's
// city. A video over the player app's own limits (50 MB, 120 s) is refused as the app refuses it.

import { localModeRefusal } from "@/lib/localMode";
import { CHAT_VIDEO_MAX_BYTES, CHAT_VIDEO_MAX_SECONDS } from "@/lib/matchChats";
import { postMatchDayMedia, readMessage } from "@/lib/matchChatWrite";
import { reviewMasked } from "@/lib/reviewAccount";
import { chatGate } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function postRoute(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  { const local = localModeRefusal("Match chat"); if (local) return local; }
  const g = await chatGate(req, ctx);
  if ("refused" in g) return g.refused;
  if (!g.canSend) return Response.json({ error: "You don't have permission to send messages.", reason: "no_send_permission" }, { status: 403 });
  let form: FormData;
  try { form = await req.formData(); } catch { return Response.json({ error: "Body must be multipart form data with a file" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file required" }, { status: 400 });
  const contentType = (file.type || "").toLowerCase();
  const isVideo = /^video\//.test(contentType);
  if (!isVideo && !/^image\//.test(contentType)) return Response.json({ error: "Only a photo or a video can be sent." }, { status: 400 });
  if (file.size > (isVideo ? CHAT_VIDEO_MAX_BYTES : MAX_IMAGE_BYTES)) {
    return Response.json({ error: isVideo ? `A video must be under ${CHAT_VIDEO_MAX_BYTES / 1024 / 1024} MB.` : `A photo must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  }
  const num = (k: string) => { const v = Number(form.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const duration = num("duration");
  if (isVideo && duration != null && duration > CHAT_VIDEO_MAX_SECONDS + 1) return Response.json({ error: `A video must be under ${CHAT_VIDEO_MAX_SECONDS} seconds.` }, { status: 413 });
  const thumb = form.get("thumbnail");
  const thumbnail = isVideo && thumb instanceof File && thumb.size > 0 ? { file: Buffer.from(await thumb.arrayBuffer()), contentType: thumb.type || "image/jpeg" } : null;
  const r = await postMatchDayMedia({
    supabase: g.auth.supabase, env: g.env, chatDocId: g.chatDocId, appUserId: g.auth.appUserId,
    file: Buffer.from(await file.arrayBuffer()), contentType, thumbnail,
    extra: isVideo ? { width: num("width"), height: num("height"), duration } : {},
    tag: `app:match-chat:${g.env}:media`, push: g.push,
  });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  const back = await readMessage(g.chatDocId, r.firestoreDocId).catch(() => null);
  return Response.json({
    ok: true, op: isVideo ? "video" : "photo", firestore_doc_id: r.firestoreDocId, message_id: r.messageId, url: r.url, thumbnail_url: r.thumbnailUrl, file_name: r.fileName, audited: r.audited, push: r.push,
    message: back,
    readBack: back ? (back.isMatchDay && back.media?.url === r.url ? "confirmed" : "disagrees") : "missing",
  });
}

export const POST = reviewMasked(postRoute);
