// Server-side Web Push helper. Wraps the `web-push` library so the
// rest of the app sees a single typed entry point + auto-cleanup of
// expired subscriptions.
//
// VAPID keypair lives in env:
//   VAPID_PUBLIC_KEY   — public; advertised to clients via the
//                        NEXT_PUBLIC_ mirror for pushManager.subscribe.
//   VAPID_PRIVATE_KEY  — secret; signs each outbound push payload.
//   VAPID_SUBJECT      — mailto: URL identifying the application
//                        server to browser vendors.
//
// Subscription expiry: push services return 410 Gone or 404 Not
// Found when the endpoint is permanently dead (user revoked at OS
// level, uninstalled the PWA, cleared site data, etc). We delete
// the matching row from push_subscriptions on those codes so future
// fan-outs skip the dead endpoint.

import "server-only";

import webpush from "web-push";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type PushPayload = {
  // Notification title — keep short, lockscreen-readable.
  title: string;
  // Notification body — kept under 80 chars to avoid lock-screen
  // truncation. Never include full message content with PII beyond
  // what the inbox row already shows.
  body: string;
  // Notification.tag — same tag collapses multiple notifications
  // into one on the lockscreen. Use thread_id so back-to-back
  // inbounds on the same thread coalesce.
  tag?: string;
  // iOS PWA home-screen badge count. When present, the SW calls
  // self.registration.setAppBadge(count). Per-recipient — different
  // viewers have different unread tallies under the assignment-
  // aware rule.
  unread_count?: number;
  // Routed by the SW notificationclick handler. `route` is the
  // in-app path to focus/open when tapped.
  data: {
    route: string;
    thread_id?: string;
    [key: string]: unknown;
  };
};

export type StoredSubscription = {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (vapidConfigured) return;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    throw new Error(
      "web-push: missing VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env",
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

function getServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "webPush: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SendResult =
  | { ok: true; statusCode: number }
  | { ok: false; expired: true; statusCode: number }
  | { ok: false; expired: false; statusCode: number | null; message: string };

// Sends a single push payload to a single subscription. On 410/404,
// deletes the row from push_subscriptions and returns expired=true.
// Other failures are returned with expired=false so the caller can
// decide whether to log + drop (typical) or retry.
export async function sendPushNotification(
  subscription: StoredSubscription,
  payload: PushPayload,
): Promise<SendResult> {
  ensureVapidConfigured();

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  const body = JSON.stringify(payload);

  try {
    const result = await webpush.sendNotification(pushSubscription, body);
    return { ok: true, statusCode: result.statusCode };
  } catch (err) {
    const e = err as { statusCode?: number; body?: string; message?: string };
    const statusCode = typeof e.statusCode === "number" ? e.statusCode : null;
    const expired = statusCode === 410 || statusCode === 404;
    if (expired) {
      // Best-effort row delete — even if it fails we still report
      // expired so the caller can move on.
      try {
        const sb = getServiceRoleClient();
        await sb
          .from("push_subscriptions")
          .delete()
          .eq("user_id", subscription.user_id)
          .eq("endpoint", subscription.endpoint);
        console.log(
          `[web-push] removed expired subscription user=${subscription.user_id} status=${statusCode}`,
        );
      } catch (cleanupErr) {
        console.error(
          `[web-push] failed to delete expired row user=${subscription.user_id}:`,
          cleanupErr,
        );
      }
      return { ok: false, expired: true, statusCode };
    }
    const message = e.message ?? String(err);
    console.error(
      `[web-push] send failed user=${subscription.user_id} status=${statusCode ?? "?"}: ${message}`,
    );
    return { ok: false, expired: false, statusCode, message };
  }
}

// Convenience fan-out for the common case (one payload, many
// subscriptions). Runs sends in parallel and returns per-subscription
// results so the caller can log aggregate stats. Never throws —
// individual failures are absorbed.
export async function sendPushNotificationToMany(
  subscriptions: StoredSubscription[],
  payload: PushPayload,
): Promise<SendResult[]> {
  if (subscriptions.length === 0) return [];
  return Promise.all(
    subscriptions.map((s) => sendPushNotification(s, payload)),
  );
}
