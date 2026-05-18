"use client";

// Bell-icon button that lives in the /chats and /match-chats status
// rows. States the user can see:
//   subscribed   → filled bell; tap to unsubscribe
//   unsubscribed → outline bell; tap to request permission + subscribe
//   denied       → bell-off; tooltip points operator at OS settings
//   unsupported  → hidden entirely (renders null)
//
// Browser support gating:
//   - Push API requires Service Worker support → checks at mount.
//   - iOS Safari only exposes Push API to PWAs installed on the
//     home screen (display-mode: standalone). In a regular tab,
//     pushManager exists on the SW registration but subscribe()
//     throws. We pre-empt with a "Add to Home Screen first" tooltip
//     so operators don't get cryptic browser errors.
//
// Authentication: subscribe/unsubscribe go through the existing
// session bearer pattern (the same fetch helper /chats and
// /match-chats use elsewhere). The Composer's bearerHeaders is
// duplicated inline here to keep this component self-contained.

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Status =
  | "unsupported" // browser lacks SW or Push API
  | "not-standalone" // iOS, opened in browser tab — install required
  | "denied" // Notification.permission === "denied"
  | "unsubscribed" // supported + standalone, no active subscription
  | "subscribed"; // active subscription present

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// Web Push uses Uint8Array for the applicationServerKey. The VAPID
// public key comes from env as a URL-safe base64 string; convert.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// iOS Safari PWA standalone detection. Two ways since iOS lies about
// display-mode in some contexts; either positive indicator suffices.
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql = window.matchMedia?.("(display-mode: standalone)");
  if (mql?.matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

export default function EnablePushNotificationsButton() {
  const [status, setStatus] = useState<Status>("unsupported");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // Probe support + current state on mount. The SW must be already
  // registered (ServiceWorkerRegistration component does that at the
  // root layout level), so we wait on navigator.serviceWorker.ready.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      ) {
        if (!cancelled) setStatus("unsupported");
        return;
      }

      // iOS PWA gating — Push API only works in standalone mode.
      // Detect at probe time and stay there until the user installs
      // and re-opens via the home-screen icon.
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS && !isStandalone()) {
        if (!cancelled) setStatus("not-standalone");
        return;
      }

      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }

      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled) setStatus(existing ? "subscribed" : "unsubscribed");
      } catch {
        if (!cancelled) setStatus("unsupported");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    setBusy(true);
    setHint(null);
    try {
      const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidPublic) {
        setHint("Push notifications are not configured for this environment.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "unsubscribed");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      // TS 5.x reports the Uint8Array generic param as ArrayBufferLike
      // which trips the PushManager.subscribe types (they want
      // BufferSource). Pass the underlying buffer.
      const applicationServerKey = urlBase64ToUint8Array(vapidPublic)
        .buffer as ArrayBuffer;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const json = sub.toJSON();
      const headers = await bearerHeaders();
      if (!headers) {
        setHint("Not signed in.");
        await sub.unsubscribe().catch(() => {});
        return;
      }

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({
          endpoint: json.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
          user_agent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        setHint("Server rejected the subscription.");
        await sub.unsubscribe().catch(() => {});
        return;
      }
      setStatus("subscribed");
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Subscribe failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setHint(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? null;
      if (sub) {
        await sub.unsubscribe().catch(() => {});
      }
      if (endpoint) {
        const headers = await bearerHeaders();
        if (headers) {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers,
            body: JSON.stringify({ endpoint }),
          }).catch(() => {});
        }
      }
      setStatus("unsubscribed");
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Unsubscribe failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (status === "unsupported") return null;

  const onClick = () => {
    if (busy) return;
    if (status === "not-standalone") {
      setHint("Add to Home Screen first, then open the installed app.");
      return;
    }
    if (status === "denied") {
      setHint("Notifications blocked — enable in browser settings.");
      return;
    }
    if (status === "subscribed") {
      void unsubscribe();
      return;
    }
    void subscribe();
  };

  const label =
    status === "subscribed"
      ? "Disable notifications"
      : status === "denied"
        ? "Notifications blocked"
        : status === "not-standalone"
          ? "Install to enable notifications"
          : "Enable notifications";

  const Icon = status === "denied" ? BellOff : Bell;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={label}
        title={label}
        style={{ touchAction: "manipulation" }}
        className={`rounded-full p-1 transition disabled:opacity-40 ${
          status === "subscribed"
            ? "text-deep-green"
            : "text-deep-green/55 hover:text-deep-green"
        }`}
      >
        <Icon
          aria-hidden
          className="h-4 w-4"
          strokeWidth={status === "subscribed" ? 2.25 : 1.75}
          fill={status === "subscribed" ? "currentColor" : "none"}
        />
      </button>
      {hint && (
        <span
          role="status"
          className="absolute right-0 top-full mt-1 w-56 rounded-md border border-cream-line bg-white px-2 py-1 text-[10px] leading-tight text-deep-green/70 shadow-sm"
          onAnimationEnd={() => setHint(null)}
        >
          {hint}
        </span>
      )}
    </div>
  );
}
