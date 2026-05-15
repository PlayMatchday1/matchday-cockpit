"use client";

// Hook that:
//   1. Calls POST /api/firebase-token with the Cockpit session bearer.
//   2. signInWithCustomToken into Firebase Auth.
//   3. Exposes the Firestore handle to consumers.
//
// Idempotent across multiple components — uses a module-level cache
// so the inbox and detail page share one Firebase Auth session per
// browser tab. The Firebase SDK auto-refreshes ID tokens, so we
// only re-mint the custom token if the user signs out / the session
// drops.

import { useEffect, useState } from "react";
import type { Firestore } from "firebase/firestore";
import { supabase } from "@/lib/supabase";
import { signInForMatchChats } from "@/lib/firebaseClient";
import type { FirebaseTokenResponse } from "@/lib/matchChats";

type FirebaseSessionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; db: Firestore }
  | { status: "error"; error: string };

let inflight: Promise<FirebaseSessionState> | null = null;
let cached: FirebaseSessionState = { status: "idle" };
const subscribers = new Set<(s: FirebaseSessionState) => void>();

function publish(s: FirebaseSessionState) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function bootstrap(): Promise<FirebaseSessionState> {
  publish({ status: "loading" });
  // Use the same Cockpit Supabase session bearer the rest of the
  // CRM client uses.
  const { data } = await supabase.auth.getSession();
  const sessionToken = data.session?.access_token;
  if (!sessionToken) {
    const next: FirebaseSessionState = {
      status: "error",
      error: "No Cockpit session — sign in again.",
    };
    publish(next);
    return next;
  }

  let resp: Response;
  try {
    resp = await fetch("/api/firebase-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const next: FirebaseSessionState = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    publish(next);
    return next;
  }

  if (!resp.ok) {
    const j = (await resp.json().catch(() => ({}))) as { error?: string };
    const next: FirebaseSessionState = {
      status: "error",
      error: j.error ?? `HTTP ${resp.status}`,
    };
    publish(next);
    return next;
  }

  const j = (await resp.json()) as FirebaseTokenResponse;
  try {
    const { db } = await signInForMatchChats(j.token, j.config);
    const next: FirebaseSessionState = { status: "ready", db };
    publish(next);
    return next;
  } catch (err) {
    const next: FirebaseSessionState = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    publish(next);
    return next;
  }
}

export function useFirebaseSession(): FirebaseSessionState {
  const [state, setState] = useState<FirebaseSessionState>(cached);
  useEffect(() => {
    subscribers.add(setState);
    setState(cached);
    if (cached.status === "idle") {
      inflight = inflight ?? bootstrap();
    }
    return () => {
      subscribers.delete(setState);
    };
  }, []);
  return state;
}
