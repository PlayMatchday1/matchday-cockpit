// One-shot end-to-end Web Push send test.
//
// Reads VAPID env from .env.local (run `vercel env pull --environment=production`
// first if the local file is stale), sends a single push to a hard-coded
// iPhone subscription, and logs every detail of the round-trip.
//
// This script is gitignored. Do not commit.

import { readFileSync } from "node:fs";
import webpush from "web-push";

// --- 1. Load VAPID env (parse-tolerant: strips surrounding quotes) -----
const envPath = "/Users/ryanmancuso/Code/matchday-cockpit/.env.local";
const env = readFileSync(envPath, "utf8");
function readEnv(name) {
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const m = env.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}
const VAPID_SUBJECT = readEnv("VAPID_SUBJECT");
const VAPID_PUBLIC_KEY = readEnv("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = readEnv("VAPID_PRIVATE_KEY");

console.log("=== VAPID env state ===");
console.log(`  VAPID_SUBJECT      : ${VAPID_SUBJECT ? `[set, "${VAPID_SUBJECT}"]` : "[MISSING]"}`);
console.log(`  VAPID_PUBLIC_KEY   : ${VAPID_PUBLIC_KEY ? `[set, ${VAPID_PUBLIC_KEY.length} chars]` : "[MISSING]"}`);
console.log(`  VAPID_PRIVATE_KEY  : ${VAPID_PRIVATE_KEY ? `[set, ${VAPID_PRIVATE_KEY.length} chars]` : "[MISSING]"}`);

if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("\nFATAL: one or more VAPID env vars are empty in .env.local.");
  console.error("Note: `vercel env pull` writes empty \"\" for env vars marked");
  console.error("Sensitive in Vercel. Confirm via Vercel UI whether the value");
  console.error("is genuinely empty in production OR just hidden from pull.");
  console.error("To run this test locally, copy VAPID_PRIVATE_KEY from the");
  console.error("Vercel dashboard (Reveal value) into .env.local manually.");
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// --- 2. Hard-coded subscription (iPhone PWA) ---------------------------
const subscription = {
  endpoint:
    "https://web.push.apple.com/QHDCrv1gNfct3bJTyWaq1oUnE-Mq3AHE7qdf4BKAfftyQlzhmwfV2zhW8bI6iIOKNt_fHhbRCUzgVbhh4ftdrFEBQw27c31hu1kVEuGDGBduLk3-PB1OxsggSdgNoHm5TMQa3Gn_xHzGO4GN5zDgLb7Be_Zf5eCMZEQ95hih498",
  keys: {
    p256dh: "BOuavJ94H6RRScdS5n2xhOMPLWVBr2Dp37kM6K9Ud5neKn8wscgcwWWYenT2IdB8ZOSnDJxln2yFKElgCwPJ2n8",
    auth: "w7Dw_Qthytxj-rou2gdEeA",
  },
};
console.log("\n=== Subscription ===");
console.log(`  endpoint host : ${new URL(subscription.endpoint).host}`);
console.log(`  endpoint len  : ${subscription.endpoint.length}`);
console.log(`  p256dh len    : ${subscription.keys.p256dh.length}`);
console.log(`  auth len      : ${subscription.keys.auth.length}`);

// --- 3. Payload, per the user's request --------------------------------
// NOTE: this is what the user asked for. It is NOT exactly what
// public/sw.js expects (the SW reads payload.tag and payload.data.route;
// it has no concept of a top-level `url`). The notification will still
// SHOW because title + body are honored, but tap-to-deep-link won't work.
// See the report after the run.
const payload = {
  title: "Test push from cockpit",
  body: "If you see this, the send path works end-to-end",
  url: "/chats",
};
const payloadJson = JSON.stringify(payload);
console.log("\n=== Payload ===");
console.log(`  ${payloadJson}`);
console.log(`  bytes: ${Buffer.byteLength(payloadJson, "utf8")}`);

// --- 4. Send -----------------------------------------------------------
console.log("\n=== Sending ===");
const startedAt = Date.now();
try {
  const result = await webpush.sendNotification(subscription, payloadJson);
  const elapsed = Date.now() - startedAt;
  console.log("=== SUCCESS ===");
  console.log(`  statusCode : ${result.statusCode}`);
  console.log(`  elapsed    : ${elapsed}ms`);
  console.log(`  headers    : ${JSON.stringify(result.headers, null, 2)}`);
  console.log(`  body       : ${result.body ? JSON.stringify(result.body) : "(empty)"}`);
} catch (err) {
  const elapsed = Date.now() - startedAt;
  console.log("=== FAILURE ===");
  console.log(`  elapsed    : ${elapsed}ms`);
  console.log(`  name       : ${err?.name ?? "?"}`);
  console.log(`  message    : ${err?.message ?? "?"}`);
  console.log(`  statusCode : ${err?.statusCode ?? "(none)"}`);
  console.log(`  headers    : ${err?.headers ? JSON.stringify(err.headers, null, 2) : "(none)"}`);
  console.log(`  body       : ${err?.body ?? "(none)"}`);
  console.log(`  endpoint   : ${err?.endpoint ?? "(none)"}`);
  if (err?.stack) {
    console.log(`  stack      :\n${err.stack.split("\n").slice(0, 10).join("\n")}`);
  }
  process.exit(1);
}
