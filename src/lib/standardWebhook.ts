// STANDARD WEBHOOKS SIGNATURE CHECK (the scheme Supabase Auth hooks sign with). Pure, node:crypto
// only, so the suite can sign a payload and verify it offline.
//
//   signed content   `${webhook-id}.${webhook-timestamp}.${raw body}`
//   key              the secret with its "v1,whsec_" prefix removed, base64-decoded
//   webhook-signature  one or more space-separated "v1,<base64 HMAC-SHA256>"
//
// The timestamp must be within five minutes either way, so a captured request cannot be replayed.

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 5 * 60;

const keyOf = (secret: string): Buffer => Buffer.from(secret.trim().replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");

export function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds: number,
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signStandardWebhook(secret, headers.id, ts, body).slice(3), "base64");
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
