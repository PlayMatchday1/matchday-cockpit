// THE STAFF APP'S CITY MANAGERS (Ryan, 2026-11-06): a city manager's grants (Match Ops, Edit
// matches, Chats, Send messages, Player Lifecycle, Growth) work in the STAFF APP, confined to their
// city, and the desktop stays exactly as it was: /city/* pages only.
//
// WHY A MARKER. The desktop gates refuse a city manager every capability whatever boxes the row
// carries (isCityManagerConfined, Phase 29b), and the staff app reaches most of its data by calling
// those same desktop handlers in process. So the lockout is lifted for a request ONLY when the
// server itself vouches that it is a staff-app request:
//   - authenticateApp marks the row it hands every /api/app/* route;
//   - every in-process forward (forwardedAuth in viewAs.ts) carries X-Clubhouse-App-Forward with a
//     value derived from the service-role key, which never leaves the server, and resolveSessionUser
//     marks the row only when that value matches. A wrong value is refused, never ignored.
// A marked city manager is then an ordinary confined account (cityConfinement.ts): the city
// boundary, the route allowlist and every write's assertMatchInScope apply unchanged.
//
// PURE APART FROM node:crypto, so the bare node test runner can load it.

import { createHmac, timingSafeEqual } from "node:crypto";

export const APP_FORWARD_HEADER = "x-clubhouse-app-forward";
/** The key a server-side gate sets on a row it vouches came through the staff app. Never a column. */
export const STAFF_APP_KEY = "__clubhouseStaffApp";

function secret(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

export function appForwardValue(s: string | null = secret()): string | null {
  return s ? createHmac("sha256", s).update("clubhouse-app-forward-v1").digest("base64url") : null;
}

/** "absent" | "valid" | "invalid" for a request's marker header. */
export function appForwardState(req: Request): "absent" | "valid" | "invalid" {
  const got = req.headers.get(APP_FORWARD_HEADER);
  if (!got) return "absent";
  const want = appForwardValue();
  if (!want) return "invalid";
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b) ? "valid" : "invalid";
}

/** A copy of the row, marked as reached through the staff app. */
export const markStaffApp = <R extends Record<string, unknown>>(row: R): R => ({ ...row, [STAFF_APP_KEY]: true });

/** The View as header (viewAs.ts VIEW_AS_HEADER), restated so this file stays import-free. */
const VIEW_AS_HEADER = "x-clubhouse-view-as";

/**
 * The headers an /api/app route hands a desktop handler it calls in process: the caller's bearer,
 * the View as header while viewing as (without it the desktop gate would answer with the admin's own
 * access), and the staff-app marker. Every in-process forward uses this.
 */
export function forwardedAuth(from: Request): Record<string, string> {
  const h: Record<string, string> = { authorization: from.headers.get("authorization") ?? "" };
  const va = from.headers.get(VIEW_AS_HEADER);
  if (va) h[VIEW_AS_HEADER] = va;
  const fwd = appForwardValue();
  if (fwd) h[APP_FORWARD_HEADER] = fwd;
  return h;
}
