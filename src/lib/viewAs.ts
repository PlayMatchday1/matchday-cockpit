// STAFF APP "VIEW AS" (Ryan, 2026-11-06): an admin sees the staff app exactly as another Clubhouse
// user does, to test what a city manager sees. READ-ONLY, ADMIN-ONLY, AND DECIDED HERE, never by the
// phone.
//
// HOW IT WORKS. POST /api/app/view-as (admin only) logs the start in change_log and hands back a
// token signed with a key derived from the service-role key: {admin id, viewed id, start, expiry}.
// While viewing, the app sends it as the X-Clubhouse-View-As header on every Clubhouse call. The two
// session resolvers every staff-app route goes through (resolveSessionUser in adminAuth.ts, which
// authenticateApp, authenticateAdmin and the Match Ops gate share, and authenticateCrm for the chat
// routes) pass the request through applyViewAs, which:
//   - refuses the header outright unless the REAL signed-in row is an unconfined admin, and the
//     token's signature, expiry and admin id all check out. A bad header is a 403, NEVER a silent
//     fall back to the admin's own access;
//   - refuses every method but GET and HEAD, whatever the viewed user could do (no saves, cancels,
//     credits, chat messages, manager changes, push settings);
//   - otherwise re-reads the viewed user's app_users row fresh and hands THAT row and email to the
//     gate, so every permission, tier and city confinement check runs on them, unchanged.
// DELETE /api/app/view-as logs the stop. The token is not stored anywhere on the server: its
// signature is the server's word that an admin started it.

import { createHmac, timingSafeEqual } from "node:crypto";
import { type SupabaseClient } from "@supabase/supabase-js";

export const VIEW_AS_HEADER = "x-clubhouse-view-as";
/** A View as lasts at most this long; after it every call is refused until Exit. */
export const VIEW_AS_TTL_MS = 4 * 60 * 60_000;

export type ViewAsClaims = { a: string; t: string; s: number; e: number };
export type ViewAsInfo = { adminId: string; adminEmail: string; adminName: string; targetId: string; startedAt: number; expiresAt: number };

export const VIEW_AS_READ_ONLY = "View as is read-only. Exit View as to make changes.";
export const VIEW_AS_ADMINS_ONLY = "View as is for admins only.";
export const VIEW_AS_INVALID = "This View as is not valid. Exit View as and start it again.";
export const VIEW_AS_EXPIRED = "This View as has ended (4 hours). Exit View as and start it again.";

const b64u = (b: Buffer) => b.toString("base64url");

function keyFrom(secret: string): Buffer {
  return createHmac("sha256", secret).update("clubhouse-view-as-v1").digest();
}

function serverSecret(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

/** PURE: sign claims with a secret. */
export function signViewAs(claims: ViewAsClaims, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(claims), "utf8"));
  const mac = b64u(createHmac("sha256", keyFrom(secret)).update(body).digest());
  return `${body}.${mac}`;
}

/** PURE: the claims if the signature is good (expiry is the caller's to judge), else null. */
export function verifyViewAs(token: string, secret: string): ViewAsClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = createHmac("sha256", keyFrom(secret)).update(parts[0]).digest();
  let got: Buffer;
  try { got = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<ViewAsClaims>;
    if (typeof c.a !== "string" || typeof c.t !== "string" || typeof c.s !== "number" || typeof c.e !== "number") return null;
    return c as ViewAsClaims;
  } catch { return null; }
}

/** isConfined from cityConfinement.ts, restated so this file loads in the bare node test runner:
 *  ANY non-blank city_identifier confines, recognised or not. */
const confinedRow = (row: Record<string, unknown>) => typeof row.city_identifier === "string" && row.city_identifier.trim().length > 0;

/** PURE: may this real row start or use a View as? An unconfined admin only. */
export function canViewAs(row: Record<string, unknown> | null | undefined): boolean {
  return !!row && row.is_admin === true && row.is_service_account !== true && !confinedRow(row);
}

/** PURE: may this method run while viewing as? Reads only. */
export const viewAsMethodAllowed = (method: string) => method === "GET" || method === "HEAD";

export function issueViewAs(adminId: string, targetId: string, now: number): string | null {
  const secret = serverSecret();
  if (!secret) return null;
  return signViewAs({ a: adminId, t: targetId, s: now, e: now + VIEW_AS_TTL_MS }, secret);
}

/** For the stop route: the claims of a token this admin holds, expired or not (an Exit after expiry
 *  is still logged). null when the signature or the admin does not match. */
export function claimsForStop(token: string, adminId: string): ViewAsClaims | null {
  const secret = serverSecret();
  if (!secret) return null;
  const c = verifyViewAs(token, secret);
  return c && c.a === adminId ? c : null;
}

export type ViewAsApplied =
  | { ok: true; row: Record<string, unknown>; email: string; viewAs: ViewAsInfo | null }
  | { ok: false; status: number; error: string };

/**
 * THE ONE PLACE A VIEW AS IS HONOURED. Called by both session resolvers after the real session and
 * the real app_users row are loaded. No header: the real row, unchanged. A header: either the viewed
 * user's fresh row, or a refusal. Never the admin's own row with a header present.
 */
export async function applyViewAs(
  req: Request, sb: SupabaseClient, realRow: Record<string, unknown>, realEmail: string, now = Date.now(),
): Promise<ViewAsApplied> {
  const token = req.headers.get(VIEW_AS_HEADER)?.trim();
  if (!token) return { ok: true, row: realRow, email: realEmail, viewAs: null };
  if (!canViewAs(realRow)) return { ok: false, status: 403, error: VIEW_AS_ADMINS_ONLY };
  const secret = serverSecret();
  if (!secret) return { ok: false, status: 500, error: "View as is not configured on the server." };
  const c = verifyViewAs(token, secret);
  if (!c || c.a !== String(realRow.id)) return { ok: false, status: 403, error: VIEW_AS_INVALID };
  if (now > c.e) return { ok: false, status: 403, error: VIEW_AS_EXPIRED };
  if (!viewAsMethodAllowed(req.method.toUpperCase())) return { ok: false, status: 403, error: VIEW_AS_READ_ONLY };
  const t = await sb.from("app_users").select("*").eq("id", c.t).maybeSingle();
  if (t.error || !t.data) return { ok: false, status: 403, error: "The account you are viewing as no longer exists. Exit View as." };
  const row = t.data as Record<string, unknown>;
  const email = typeof row.email === "string" ? row.email.toLowerCase() : "";
  if (!email) return { ok: false, status: 403, error: "The account you are viewing as has no email. Exit View as." };
  return {
    ok: true, row, email,
    viewAs: {
      adminId: String(realRow.id), adminEmail: realEmail,
      adminName: typeof realRow.full_name === "string" ? realRow.full_name : realEmail,
      targetId: c.t, startedAt: c.s, expiresAt: c.e,
    },
  };
}

