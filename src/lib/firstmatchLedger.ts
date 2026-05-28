// First-match abuse ledger — hashing + normalization primitives.
//
// One-way HMAC-SHA256 over a fixed app-side salt (FIRSTMATCH_LEDGER_SALT,
// env-only — never in code or git). The same phone / email always hashes
// to the same value so cross-account reuse is detectable, but the raw
// value is never recoverable from the ledger.
//
// The salt is read lazily at first hash (NOT at module load) so the
// backfill script can populate process.env from .env.local before the
// first call. Missing salt throws — we never silently emit unsalted /
// empty hashes, which would produce a uselessly unmatchable ledger.

import { createHmac } from "node:crypto";

let cachedSalt: string | null = null;

function getSalt(): string {
  if (cachedSalt !== null) return cachedSalt;
  const s = process.env.FIRSTMATCH_LEDGER_SALT;
  if (!s || s.trim().length === 0) {
    throw new Error(
      "FIRSTMATCH_LEDGER_SALT is not set — refusing to hash. Set it in " +
        "Vercel env (cron) and .env.local (backfill) before running.",
    );
  }
  cachedSalt = s;
  return s;
}

// Account deletion on the MatchDay side scrubs the email to
// `del_<hex>@playmatchday.com` and nulls the phone. Detect that token so
// such rows are recorded as unrecoverable markers, never hashed as if
// they were a real identity. Anchored on the `del_` + hex prefix (not the
// domain) so real staff @playmatchday.com addresses are NOT misread as
// scrubbed.
export function isScrubbedEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^del_[0-9a-f]{8,}@/i.test(raw.trim());
}

// Email normalization is deliberately conservative: trim + lowercase
// only. No plus-alias / gmail-dot stripping — that changes semantics for
// providers that treat them as distinct, and the OR-match on phone
// already catches an abuser who only varies their email alias.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Phone normalization: reduce to bare digits, then drop a US country code
// so "+1 (512) 555-1212", "1-512-555-1212" and "5125551212" all collapse
// to the same 10-digit key. Returns null for anything too short to be a
// real number (so it hashes to nothing rather than a collision-prone stub).
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (digits.length < 10) return null;
  return digits;
}

// HMAC-SHA256 hex. The kind prefix is a domain separator so a phone and
// an email can never collide into the same hash.
export function hashIdentifier(kind: "phone" | "email", value: string): string {
  return createHmac("sha256", getSalt())
    .update(`${kind}:${value}`)
    .digest("hex");
}

// Convenience: hash a raw email/phone after normalization, or return null
// when the value is absent / scrubbed / too short. Centralizes the
// "what becomes a hash vs null" decision so backfill and cron agree.
export function emailHashOrNull(rawEmail: string | null | undefined): string | null {
  if (!rawEmail || isScrubbedEmail(rawEmail)) return null;
  const norm = normalizeEmail(rawEmail);
  if (norm.length === 0) return null;
  return hashIdentifier("email", norm);
}

export function phoneHashOrNull(rawPhone: string | null | undefined): string | null {
  const norm = normalizePhone(rawPhone);
  if (norm === null) return null;
  return hashIdentifier("phone", norm);
}
