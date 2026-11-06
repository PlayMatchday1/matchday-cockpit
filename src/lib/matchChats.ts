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
  reactions: { key: string; count: number }[];
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
    ? REACTION_KEYS.filter((k) => Array.isArray(m.reactions?.[k]) && (m.reactions?.[k] as unknown[]).length > 0).map((k) => ({ key: k, count: (m.reactions?.[k] as unknown[]).length }))
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
