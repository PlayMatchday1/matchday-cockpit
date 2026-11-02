// THE APP STORE REVIEW ACCOUNT (Ryan, 2026-11-02). Apple signs into the staff app with one phone
// number and one fixed code, both server env (APP_REVIEW_PHONE, APP_REVIEW_CODE; either empty turns
// it off). They sign into REVIEW_EMAIL only: an Austin-confined app_users row with no write grant.
//
//   NO TEXT     the start route never asks Supabase for a code for that number, and the Send SMS hook
//               refuses it as well.
//   LOGGED      every attempt is a row in app_review_sign_ins (migration 0248).
//   READ ONLY   src/proxy.ts refuses the account's token everywhere except GETs on the paths the app
//               reads (REVIEW_READ_PREFIXES), and refuses manager pay outright ("Not available").
//   MASKED      every GET the app reads goes through reviewMasked, which rewrites the JSON for this
//               account only: player names to first name plus last initial, no phone numbers or
//               emails, chat bodies "Message hidden", review comments "Comment hidden" (stars and
//               tags kept), notes "Note hidden", no player photos. Counts, ratings, matches and
//               fields stay real.
//
// The proxy and the wrapper read the email from the token WITHOUT verifying it. That is safe in the
// one direction they use it: a token that claims the review email only gets refused or masked, and
// every route still verifies the token itself before answering.

import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const REVIEW_EMAIL = "app-review@playmatchday.com";
export const REVIEW_FAILS_PER_HOUR = 5;

/** The review account must stay Austin-confined with no admin flag and no write grant. */
const REVIEW_FORBIDDEN = ["is_admin", "is_service_account", "is_city_manager", "can_edit_matches", "can_send_messages", "can_manage_players",
  "can_manage_promos", "can_edit_credits", "can_edit_memberships"] as const;
export const reviewAccountSafe = (row: Record<string, unknown>) => row.city_identifier === "ATX" && REVIEW_FORBIDDEN.every((k) => row[k] !== true);

/** The review number and code, or null when either env var is empty (the switch is off). */
export function reviewCredentials(): { phone: string; code: string } | null {
  const phone = process.env.APP_REVIEW_PHONE?.trim() ?? "";
  const code = process.env.APP_REVIEW_CODE?.trim() ?? "";
  return phone && /^\d{6}$/.test(code) ? { phone, code } : null;
}

export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The email claim of the request's bearer token, unverified (see the header). */
export function tokenEmail(authorization: string | null): string | null {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const isReviewToken = (authorization: string | null) => tokenEmail(authorization) === REVIEW_EMAIL;

/** One row in app_review_sign_ins (migration 0248) for every attempt on the review number. */
export type ReviewOutcome = "code_requested" | "signed_in" | "wrong_code" | "locked" | "account_unsafe";

export async function logReviewAttempt(sb: SupabaseClient, req: Request, outcome: ReviewOutcome): Promise<void> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || null;
  const { error } = await sb.from("app_review_sign_ins").insert({ outcome, ip, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null });
  console.log(`[review-sign-in] ${outcome}${error ? ` (log write failed: ${error.message})` : ""}`);
}

/* ── READ ONLY ───────────────────────────────────────────────────────────────────────────────── */

export const REVIEW_READ_PREFIXES = ["/api/app/", "/api/crm/threads", "/api/crm/canned-responses", "/api/crm/metrics", "/api/match-chats/"];
const REVIEW_NOT_AVAILABLE = ["/api/app/manager-pay"];

/** Pure: the proxy's answer for the review account, or null to let the request through. */
export function reviewRefusal(method: string, pathname: string): { status: number; error: string } | null {
  if (REVIEW_NOT_AVAILABLE.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return { status: 403, error: "Not available" };
  if ((method === "GET" || method === "HEAD") && REVIEW_READ_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  return { status: 403, error: "The review account is read only." };
}

/* ── MASKED ──────────────────────────────────────────────────────────────────────────────────── */

const HIDDEN_MESSAGE = "Message hidden";
const HIDDEN_COMMENT = "Comment hidden";
const HIDDEN_NOTE = "Note hidden";

/** "Sam Rivera" -> "Sam R.", "Sam" -> "Sam". */
export function shortName(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return s.trim();
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

const FULL_NAME_KEYS = new Set(["fullName", "full_name", "displayName", "display_name", "playerName", "player_name", "managerName",
  "primaryManagerName", "contactName", "contact_name", "senderName", "sender_name", "authorName", "author_name", "profileName",
  "profile_name", "customerName", "customer_name", "memberName", "member_name", "whatsappName", "whatsapp_name", "sent_by", "sentBy", "sender",
  "author", "created_by_name", "createdByName", "closed_by_name", "closedByName", "operator_name", "operatorName", "assignee_name", "assigneeName"]);
const LAST_NAME_RX = /last_?name$|^surname$/i;
// A person's name under any prefix (manager_name, primaryManagerName, contact_display_name...); never
// cityName, fieldName, teamName or matchName.
const PERSON_NAME_RX = /(full|display|player|manager|contact|sender|author|customer|member|profile|whatsapp|operator|assignee|created_?by|closed_?by|reviewer|staff)_?name$/i;
const MESSAGE_KEYS = new Set(["body", "text", "message", "messageBody", "message_body", "content", "preview", "snippet", "lastMessage",
  "last_message", "lastMessageText", "last_message_text", "lastMessagePreview", "last_message_preview", "caption", "transcript",
  "transcription", "quote", "quoted", "quotedText", "quoted_text"]);
const COMMENT_KEYS = new Set(["comment", "comments", "reviewComment", "review_comment", "feedback"]);
const NOTE_KEYS = new Set(["note", "notes", "internalNote", "internal_note", "managerNote", "manager_note"]);
const PHOTO_RX = /avatar|photo|picture|profileImage|profile_image|^imageUrl$|^image_url$|mediaUrl|media_url|attachment/i;
const PERSON_HINT_KEYS = new Set(["playerId", "player_id", "userId", "user_id", "userMatchId", "phone", "phoneNumber", "phone_number",
  "email", "initials", "firstName", "first_name", "lastName", "last_name", "bib"]);
const PERSON_PARENT_RX = /player|manager|member|contact|sender|author|participant|review|comment|ranked|toofew|user|customer|attendee|waitlist|people|person|staff|recipient|roster|signup|guest/i;
const COMMENT_PARENT_RX = /comment|review/i;
const EMAIL_RX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RX = /\+\d{10,15}|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

function scrub(s: string): string {
  return s.replace(EMAIL_RX, "hidden").replace(PHONE_RX, "hidden");
}

/** Pure: the payload as the review account sees it. Never mutates its input. */
export function maskForReview(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskForReview(v, parentKey));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const person = PERSON_PARENT_RX.test(parentKey) || Object.keys(o).some((k) => PERSON_HINT_KEYS.has(k));
    const inComments = COMMENT_PARENT_RX.test(parentKey);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        if (/phone|email/i.test(k)) out[k] = null;
        else if (FULL_NAME_KEYS.has(k) || PERSON_NAME_RX.test(k) || (k === "name" && person)) out[k] = shortName(v);
        else if (LAST_NAME_RX.test(k)) out[k] = v.trim() ? `${v.trim()[0].toUpperCase()}.` : v;
        else if (COMMENT_KEYS.has(k)) out[k] = v.trim() ? HIDDEN_COMMENT : v;
        else if (MESSAGE_KEYS.has(k)) out[k] = !v.trim() ? v : inComments ? HIDDEN_COMMENT : HIDDEN_MESSAGE;
        else if (NOTE_KEYS.has(k)) out[k] = v.trim() ? HIDDEN_NOTE : v;
        else if (PHOTO_RX.test(k) && (person || /message|chat|thread/i.test(parentKey))) out[k] = null;
        else out[k] = scrub(v);
      } else {
        out[k] = maskForReview(v, k);
      }
    }
    return out;
  }
  return typeof value === "string" ? scrub(value) : value;
}

/** Wraps a GET handler: the review account's JSON is masked; everyone else's response is untouched. */
export function reviewMasked<R extends Request, A extends unknown[], T extends Response | undefined>(handler: (req: R, ...rest: A) => T | Promise<T>) {
  return async (req: R, ...rest: A): Promise<T | Response> => {
    const res = await handler(req, ...rest);
    if (!res || !isReviewToken(req.headers.get("authorization"))) return res;
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
    const body = await res.clone().json().catch(() => undefined);
    if (body === undefined) return res;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(maskForReview(body)), { status: res.status, statusText: res.statusText, headers });
  };
}
