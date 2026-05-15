"use client";

// Client-side Firebase initialization for the Match Chats feature.
// Mints exactly one FirebaseApp + Auth + Firestore handle per browser
// session. The custom token + web config arrive via /api/firebase-token
// (server-minted) — we don't ship apiKey/authDomain as build-time env
// vars to keep the surface narrow.
//
// initializeApp throws if called twice with the same name, so we
// guard with getApps(). Next.js HMR re-imports modules; this matters.

import {
  initializeApp,
  getApps,
  type FirebaseApp,
} from "firebase/app";
import {
  getAuth,
  signInWithCustomToken,
  type Auth,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import type { FirebaseWebConfig } from "@/lib/matchChats";

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let cachedConfigSig: string | null = null;

function configSignature(c: FirebaseWebConfig): string {
  return `${c.projectId}:${c.apiKey}:${c.appId}`;
}

// Returns initialized handles for a given web config. If a previous
// init used a different config (shouldn't happen in production, but
// can during development if someone rotates keys), we reuse the
// existing app — Firebase only allows one app per name.
function ensureApp(config: FirebaseWebConfig): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
} {
  const sig = configSignature(config);
  if (cachedApp && cachedAuth && cachedDb && cachedConfigSig === sig) {
    return { app: cachedApp, auth: cachedAuth, db: cachedDb };
  }
  const existing = getApps();
  const app =
    existing.length > 0
      ? existing[0]
      : initializeApp({
          projectId: config.projectId,
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          appId: config.appId,
        });
  cachedApp = app;
  cachedAuth = getAuth(app);
  cachedDb = getFirestore(app);
  cachedConfigSig = sig;
  return { app, auth: cachedAuth, db: cachedDb };
}

// Sign in with a custom token minted by /api/firebase-token. Returns
// the Firestore handle the caller will use to subscribe to listeners.
// The Firebase Auth session, once established, refreshes its own ID
// tokens automatically — we don't need to re-mint the custom token
// during a session.
export async function signInForMatchChats(
  token: string,
  config: FirebaseWebConfig,
): Promise<{ db: Firestore; auth: Auth }> {
  const { auth, db } = ensureApp(config);
  if (!auth.currentUser) {
    await signInWithCustomToken(auth, token);
  }
  return { db, auth };
}

export function getFirebaseDb(): Firestore | null {
  return cachedDb;
}
