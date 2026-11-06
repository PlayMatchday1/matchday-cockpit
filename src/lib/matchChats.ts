// Shared types + helpers for the Match Chats feature, used by both
// the API routes and the client UI.

// ============================================================
// API response shapes
// ============================================================

export type FirebaseWebConfig = {
  projectId: string;
  apiKey: string;
  authDomain: string;
  appId: string;
};

export type FirebaseTokenResponse = {
  token: string;
  config: FirebaseWebConfig;
  expiresAt: string; // ISO; informational, SDK auto-refreshes ID tokens
};

// Inbox row shared by all three sections. `section` lets the client
// render without re-deriving categorization.
export type MatchChatInboxRow = {
  section: "active" | "upcoming" | "past";
  chat_id: string; // numeric string ("14613"); the Firestore parent doc id
  match: {
    api_id: number | null;
    field_title: string | null;
    // ISO. Sourced from mdapi_matches.start_date_utc — the column
    // that is actually UTC. mdapi_matches also has a `start_date`
    // column whose value is the LOCAL wall-clock time written with
    // a +00 offset (i.e. mislabeled as UTC by the upstream API
    // copy). Reading that column produces a 5-hour skew for CDT
    // matches, etc. See PR notes.
    start_date_utc: string | null;
    city_identifier: string | null;
    manager_email: string | null;
    is_cancelled: boolean;
  } | null;
  last_message: {
    sent_at: string; // ISO
    body: string | null;
    sent_by: string | null;
  } | null;
};

export type MatchChatInboxResponse = {
  active: MatchChatInboxRow[];
  upcoming: MatchChatInboxRow[];
  past: MatchChatInboxRow[];
};

// ============================================================
// Firestore message shape (mirrors the documented schema)
// ============================================================
// `text` is null on media-only messages. `messageType` is "Text" or
// a MIME-style string ("video/mp4", "image/jpeg", …). `image` is a
// legacy URL field still being written by the mobile app — present
// on some video messages as a thumbnail.

export type FirestoreMessage = {
  _id: string;
  text: string | null;
  messageType: string;
  media?: { fileName?: string; type: string; url: string; thumbnailUrl?: string | null; duration?: number | null } | null;
  image?: string | null;
  sentBy: string;
  sentTo: string;
  user?: {
    _id?: string | number;
    name?: string;
    avatar?: string | null;
    email?: string;
    phoneNumber?: string;
  } | null;
  // Either a Firestore Timestamp (server) or {seconds, nanoseconds}
  // (wire) — call createdAtToIso() to normalize.
  createdAt?: unknown;
  /* THE PLAYER APP'S CHAT ACTIONS (MatchDay 1.87, src/components/chat): a reply carries a snapshot
   * of the message it answers, reactions are lists of user ids per key, an edit replaces the text,
   * a delete blanks the message and hides it. Each carries an "...Of: <document id>" marker because
   * older app versions copy every field of the newest message into the next photo or video they
   * send: a copied field whose marker is another document's id belongs to that other document and
   * is ignored. messageOut() below honours the markers exactly as the player app does. */
  replyTo?: ReplyQuote | null;
  replyOf?: string | null;
  reactions?: Partial<Record<string, unknown[]>> | null;
  reactionsOf?: string | null;
  editedAt?: unknown;
  editedOf?: string | null;
  deletedAt?: unknown;
  deletedBy?: string | null;
  deletedOf?: string | null;
};

/** The snapshot a reply carries of the message it answers (the player app's replies.ts). */
export type ReplyQuote = { docId: string; userId: string | number | null; name: string; preview: string; messageType: string };

// ============================================================
// Helpers
// ============================================================

// Normalize the various Firestore createdAt shapes (admin SDK Timestamp,
// client SDK Timestamp, plain {_seconds,_nanoseconds}, ISO string,
// Date, number) to a single ISO string. Returns null for unparseable
// values rather than throwing — callers want to render gracefully.
export function createdAtToIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof v === "number") {
    return new Date(v).toISOString();
  }
  // Admin/Client Timestamp objects expose toDate()
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  // Wire-format from JSON.stringify(Timestamp): { _seconds, _nanoseconds }
  // or { seconds, nanoseconds }.
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const s =
      typeof o.seconds === "number"
        ? o.seconds
        : typeof o._seconds === "number"
          ? o._seconds
          : null;
    const n =
      typeof o.nanoseconds === "number"
        ? o.nanoseconds
        : typeof o._nanoseconds === "number"
          ? o._nanoseconds
          : 0;
    if (s != null) return new Date(s * 1000 + Math.floor(n / 1e6)).toISOString();
  }
  return null;
}

// Returns "Image" | "Video" | "Text" | "Other" — used for media-type
// dispatch in the message renderer. Defensive against unknown MIME
// strings; anything that isn't recognized falls into "Other" and the
// UI shows the unsupported-message fallback.
export type MessageKind = "Text" | "Image" | "Video" | "Other";

export function classifyMessage(msg: FirestoreMessage): MessageKind {
  const t = (msg.messageType ?? "").toLowerCase();
  if (t === "text") return "Text";
  if (t.startsWith("image/")) return "Image";
  if (t.startsWith("video/")) return "Video";
  return "Other";
}

// Returns the best URL for an Image or Video message. Prefer
// `media.url` (newer schema); fall back to legacy `image`.
export function messageMediaUrl(msg: FirestoreMessage): string | null {
  if (msg.media?.url) return msg.media.url;
  if (msg.image) return msg.image;
  return null;
}

// Numeric chat IDs only — Firestore has ~7 non-numeric stragglers
// (test / legacy docs) that we never want to render in the inbox.
export function isValidChatId(id: string): boolean {
  return /^\d+$/.test(id);
}

// ============================================================
// Constants
// ============================================================

// Cockpit-authored messages all use this sentBy + user._id values.
// Players see a unified "MatchDay" voice; internal accountability
// lives in match_chat_audit_log.
export const MATCHDAY_SENDER_NAME = "MatchDay";
// Numeric sentinel chosen to match the player message shape: every
// real player has `user._id` as a number (mdapi auto-increment id,
// currently 4-digit range — player 4307 in our investigation
// sample). The consumer React Native app appears to do arithmetic
// or numeric comparisons on this field (probably via a custom
// react-native-gifted-chat bubble renderer) — a string here
// produces NaN and renders the Cockpit's bubble clipped off the
// left edge of the screen.
//
// 9999999999 (10 digits, ~9.99 billion) is well past any plausible
// mdapi auto-increment for decades, and well under Number
// .MAX_SAFE_INTEGER (9.0 × 10¹⁵) so it round-trips through JSON
// /Firestore without precision loss. Recognizable in logs as the
// "all nines" Cockpit sender.
//
// avatar: "" matches modern player shape. Previously tried null (PR #37
// comment asserted it was safe based on legacy-player rendering), but
// clipping persisted on the consumer app. Moved to "" to match real
// player payloads exactly.
export const MATCHDAY_SENDER_USER_ID = 9999999999;

// Public URL the MatchDay player app fetches as the avatar for Clubhouse-authored messages: the
// branded icon behind playmatchday.com's apple-touch-icon, uploaded 2023-06 and stable since, and
// hosted outside this deployment so a Clubhouse change can never break a stored message. Earlier
// values ("" and a Vercel-hosted PWA icon) clipped the bubble or 404'd (PRs #75, #76).
export const MATCHDAY_AVATAR_URL = "https://www.playmatchday.com/wp-content/uploads/2023/06/icon2-300x300.jpg";

/* STAGING AND PRODUCTION SHARE ONE FIREBASE PROJECT, and staging match ids are also production
 * match ids. The player app keeps a staging build's chats under a "staging_" prefix
 * (frontend src/config.ts, firestoreChatId) so a test post never lands in a real match's chat. The
 * staff app's chat routes take the environment they are called for and use the same prefix. */
export type ChatEnv = "staging" | "production";
export const firestoreChatId = (env: ChatEnv, chatId: string): string => (env === "staging" ? `staging_${chatId}` : chatId);

/* ── A MESSAGE AS THE STAFF APP SEES IT ──────────────────────────────────────────────────────────
 * One shape for every reader: the desktop's own list route and the app's per-environment route.
 * The player app's rules, line for line (messageEdits.ts, reactions.ts, replies.ts): a marker
 * counts only when it names this document; a deleted message is hidden; the quote's preview is
 * the stored snapshot. Phone numbers and emails on the user block are never passed on. */

export const DELETED_TEXT = "This message was deleted";
export const REACTION_KEYS = ["md", "ball", "thumbs", "fire", "joy", "heart", "eyes"] as const;

export type MessageOut = {
  id: string;
  messageId: string | null;
  text: string | null;
  kind: string;
  sentBy: string | null;
  isMatchDay: boolean;
  user: { id: string | number | null; name: string | null; avatar: string | null };
  imageUrl: string | null;
  media: { url: string; type: string; thumbnailUrl: string | null; fileName: string | null; duration: number | null } | null;
  sentAt: string | null;
  replyTo: ReplyQuote | null;
  reactions: { key: string; count: number; mine: boolean }[];
  edited: boolean;
  deleted: boolean;
};

export const isDeletedDoc = (docId: string, m: FirestoreMessage): boolean => m.deletedAt != null && m.deletedOf === docId;
export const isEditedDoc = (docId: string, m: FirestoreMessage): boolean => m.editedAt != null && m.editedOf === docId;

/** The one line a reply quotes (the player app's replyPreviewFor): 90 characters of the text, or Photo / Video. */
export function replyPreviewFor(m: Pick<FirestoreMessage, "text" | "messageType">): string {
  const text = typeof m.text === "string" ? m.text.trim() : "";
  if (text) {
    const oneLine = text.replace(/\s+/g, " ");
    return oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
  }
  const type = m.messageType ?? "";
  if (type.includes("image")) return "Photo";
  if (type.includes("video")) return "Video";
  return "";
}

export function messageOut(docId: string, m: FirestoreMessage): MessageOut {
  const kind = m.messageType ?? "Text";
  const mediaType = m.media?.type ?? "";
  const media = m.media?.url
    ? { url: m.media.url, type: mediaType || kind, thumbnailUrl: m.media.thumbnailUrl ?? null, fileName: m.media.fileName ?? null, duration: typeof m.media.duration === "number" ? m.media.duration : null }
    : null;
  const imageUrl = /^image\//i.test(kind) ? (media?.url ?? m.image ?? null) : (m.image && !/^video\//i.test(kind) ? m.image : null);
  const reactions = m.reactionsOf === docId && m.reactions
    ? REACTION_KEYS.filter((k) => Array.isArray(m.reactions?.[k]) && (m.reactions?.[k] as unknown[]).length > 0).map((k) => ({ key: k, count: (m.reactions?.[k] as unknown[]).length, mine: (m.reactions?.[k] as unknown[]).some((id) => sameUser(id, MATCHDAY_SENDER_USER_ID)) }))
    : [];
  const replyTo = m.replyOf === docId && m.replyTo && typeof m.replyTo.docId === "string"
    ? { docId: m.replyTo.docId, userId: m.replyTo.userId ?? null, name: m.replyTo.name || "A player", preview: typeof m.replyTo.preview === "string" ? m.replyTo.preview : "", messageType: m.replyTo.messageType || "Text" }
    : null;
  return {
    id: docId,
    messageId: typeof m._id === "string" || typeof m._id === "number" ? String(m._id) : null,
    text: m.text ?? null,
    kind,
    sentBy: m.sentBy || m.user?.name || null,
    isMatchDay: m.sentBy === MATCHDAY_SENDER_NAME,
    user: { id: m.user?._id ?? null, name: m.user?.name ?? null, avatar: m.user?.avatar && !/Placeholder\.png/.test(m.user.avatar) ? m.user.avatar : null },
    imageUrl,
    media,
    sentAt: createdAtToIso(m.createdAt),
    replyTo,
    reactions,
    edited: isEditedDoc(docId, m),
    deleted: isDeletedDoc(docId, m),
  };
}

// Active section: messages newer than this many days.
export const ACTIVE_WINDOW_DAYS = 7;

// Upcoming section: matches starting within this many days.
export const UPCOMING_WINDOW_DAYS = 3;

// Past section: matches whose end_date_utc fell within this many days
// before now. Allowed to overlap with Active — a match that ended in
// the last 7 days and ALSO had recent chat activity appears in both
// tabs by design.
export const PAST_WINDOW_DAYS = 7;

// Detail-view pagination.
export const MESSAGE_PAGE_SIZE = 50;

/* ── THE PLAYER APP'S CHAT TOOLS, AS MATCHDAY (MatchDay 1.87 reactions.ts, messageEdits.ts,
 * typing.ts), pure. The writer in matchChatWrite.ts applies these to Firestore. ─────────────── */

export const sameUser = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);

export type Reactions = Partial<Record<string, unknown[]>>;

/** The player app's toggledReactions, line for line: add the key for this user, or take it away; other keys stay. */
export function toggledReactions(reactions: Reactions | undefined, userId: unknown, key: string): Reactions {
  const next: Reactions = {};
  for (const [k, ids] of Object.entries(reactions ?? {})) {
    const list = Array.isArray(ids) ? ids : [];
    if (list.length) next[k] = list;
  }
  const ids = next[key] ?? [];
  if (ids.some((id) => sameUser(id, userId))) {
    const others = ids.filter((id) => !sameUser(id, userId));
    if (others.length) next[key] = others; else delete next[key];
  } else {
    next[key] = [...ids, userId];
  }
  return next;
}
export const isReactionKey = (k: unknown): k is (typeof REACTION_KEYS)[number] => typeof k === "string" && (REACTION_KEYS as readonly string[]).includes(k);

/** Only a Clubhouse-authored message (the MatchDay sender) may be edited by staff, never a player's, never a deleted one. */
export function editRefusal(docId: string, m: FirestoreMessage): string | null {
  if (isDeletedDoc(docId, m)) return "That message was deleted.";
  if (m.sentBy !== MATCHDAY_SENDER_NAME || !sameUser(m.user?._id, MATCHDAY_SENDER_USER_ID)) return "Only a message sent as MatchDay can be edited, never a player's.";
  if (!/^text$/i.test(m.messageType ?? "")) return "Only a text message can be edited.";
  return null;
}

/** Typing entries live in Chats/{chat}/typing/{userId}: {userId, name, avatar, at}. Shown for 5 s from `at`, written every 3 s. */
export const TYPING_MAX_AGE_MS = 5_000;
export const TYPING_WRITE_INTERVAL_MS = 3_000;
export type Typer = { userId: string | number | null; name: string; at: string | null };
export function activeTypers(entries: readonly Typer[], nowMs: number, exceptUserId: unknown = MATCHDAY_SENDER_USER_ID): Typer[] {
  return entries
    .filter((e) => !sameUser(e.userId, exceptUserId))
    .filter((e) => { const at = e.at ? Date.parse(e.at) : NaN; return Number.isFinite(at) && nowMs - at >= -TYPING_MAX_AGE_MS && nowMs - at < TYPING_MAX_AGE_MS; })
    .sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
}
/** The player app's typingLabel: first names, "X is typing…", "X and Y are typing…", "X and N others are typing…". */
export function typingLabel(names: readonly string[]): string {
  const people = names.map((n) => (n || "Someone").trim().split(/\s+/)[0]).filter(Boolean);
  if (people.length === 0) return "";
  if (people.length === 1) return `${people[0]} is typing…`;
  if (people.length === 2) return `${people[0]} and ${people[1]} are typing…`;
  return `${people[0]} and ${people.length - 1} others are typing…`;
}

/* ── THE "NEW MESSAGE" PUSH. The player app asks the MatchDay API (POST chats/matches/{id}/
 * notifications {message, type}) after every post it writes; the API fans out to the match's
 * registered players' devices (user_devices), minus the sender, anyone who muted the chat and
 * anyone who turned pushes off, with the match name as the title and the message as the body.
 * A MatchDay post asks the same endpoint, as MatchDay: the body names the sender because the push
 * has no other sender slot. A burst of staff messages sends one push: the second within the
 * window is held back (the players already have a push to open the chat with). */
export const PUSH_WINDOW_MS = 60_000;
export type PushKind = "TEXT" | "IMAGE" | "VIDEO";
export function pushBody(kind: PushKind, text: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (kind === "TEXT" && t) return `MatchDay: ${t.length > 180 ? `${t.slice(0, 179)}…` : t}`;
  return "MatchDay: New message";
}
export function pushDecision(lastPushedAtMs: number | null, nowMs: number): { send: boolean; reason: string } {
  if (lastPushedAtMs != null && nowMs - lastPushedAtMs < PUSH_WINDOW_MS) return { send: false, reason: `held: a push went ${Math.round((nowMs - lastPushedAtMs) / 1000)}s ago, under the ${PUSH_WINDOW_MS / 1000}s window` };
  return { send: true, reason: "sent" };
}

/* ── MEDIA. The player app uploads a picked photo as it is (picker quality 0.8) to
 * chat_media/images/{Date.now()}_{random}.{ext} in the matchday-sc.appspot.com bucket, a video
 * compressed to 1280 px / 2 Mbps H.264 mp4 to chat_media/videos/{base}.mp4 with its thumbnail at
 * chat_media/thumbnails/{base}.jpg (jpeg 0.7), and a staging build keeps everything under
 * chat_media/staging/. The URL is the Firebase download URL (alt=media&token=…). The message is
 * text null, image = the file's url, messageType = the file's mime, media = {type, url, fileName}
 * plus, for a video, thumbnailUrl, width, height, duration, size. */
export const CHAT_MEDIA_BUCKET = "matchday-sc.appspot.com";
export const CHAT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const CHAT_VIDEO_MAX_SECONDS = 120;
export const mediaRoot = (env: ChatEnv) => (env === "staging" ? "chat_media/staging" : "chat_media");
export function mediaFileName(contentType: string, nowMs = Date.now(), random = Math.random().toString(36).slice(2)): string {
  const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : contentType === "image/heic" ? "heic" : contentType === "image/gif" ? "gif" : contentType === "image/webp" ? "webp" : contentType === "video/mp4" ? "mp4" : contentType === "video/quicktime" ? "mov" : contentType.split("/")[1] || "bin";
  return `${nowMs}_${random}.${ext}`;
}
export const downloadUrl = (bucket: string, path: string, token: string) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
export type MediaExtra = { thumbnailUrl?: string; width?: number; height?: number; duration?: number; size?: number };
/** The media fields of a photo or video message, exactly as the player app's sendMedia writes them (no undefined field). */
export function mediaFields(contentType: string, url: string, fileName: string, extra: MediaExtra = {}) {
  const media: Record<string, unknown> = { type: contentType, url, fileName };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) media[k] = v;
  return { text: null, image: url, messageType: contentType, media };
}
