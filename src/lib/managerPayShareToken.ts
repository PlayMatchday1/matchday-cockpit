import "server-only";

// The shareable read-only link for Manager Pay. ONE token for the whole page,
// stored only as a SHA-256 hash (never plaintext). An admin rotates it, which
// mints a new token and instantly invalidates the old link. The plaintext is
// returned once at rotation for the admin to copy; it is never persisted and
// cannot be read back — to get the link again, rotate.
//
// The public shared endpoint hashes the token from the URL and constant-time
// compares it to the stored hash. A wrong or rotated token has no matching hash
// and the endpoint returns 404 (not 403 — a 403 would confirm the URL shape).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url"); // ~43 chars, unguessable
  return { token, hash: hashShareToken(token) };
}

// Constant-time compare of a candidate token against a stored hash.
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  if (!token || !storedHash) return false;
  const a = Buffer.from(hashShareToken(token), "hex");
  let b: Buffer;
  try { b = Buffer.from(storedHash, "hex"); } catch { return false; }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
