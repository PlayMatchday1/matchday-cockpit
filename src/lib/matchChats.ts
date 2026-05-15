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

// Inbox row shared by both sections. `section` lets the client render
// without re-deriving categorization.
export type MatchChatInboxRow = {
  section: "active" | "upcoming";
  chat_id: string; // numeric string ("14613"); the Firestore parent doc id
  match: {
    api_id: number | null;
    field_title: string | null;
    start_date: string | null; // ISO
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
  media?: { fileName: string; type: string; url: string } | null;
  image?: string | null;
  sentBy: string;
  sentTo: string;
  user?: {
    _id?: string;
    name?: string;
    avatar?: string | null;
    email?: string;
    phoneNumber?: string;
  } | null;
  // Either a Firestore Timestamp (server) or {seconds, nanoseconds}
  // (wire) — call createdAtToIso() to normalize.
  createdAt?: unknown;
};

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
export const MATCHDAY_SENDER_USER_ID = "cockpit:matchday-system";

// Active section: messages newer than this many days.
export const ACTIVE_WINDOW_DAYS = 7;

// Upcoming section: matches starting within this many days.
export const UPCOMING_WINDOW_DAYS = 3;

// Detail-view pagination.
export const MESSAGE_PAGE_SIZE = 50;
