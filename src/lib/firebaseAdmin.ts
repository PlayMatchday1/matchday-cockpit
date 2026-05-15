// Server-side firebase-admin singleton. Used by the Match Chats API
// routes (token minting, inbox query, reply writes + audit).
//
// Credential lookup order:
//   1. ./firebase-service-account.json — local dev only, gitignored.
//      Preferred locally because the production env var is "Sensitive"
//      and pulls as empty.
//   2. FIREBASE_SERVICE_ACCOUNT_JSON — Vercel env (Sensitive). The
//      production path.
//
// Initialization is idempotent (Next.js HMR re-imports the module on
// every reload; firebase-admin throws on duplicate initializeApp). We
// reuse admin.apps[0] when present.

import "server-only";

import admin from "firebase-admin";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_KEY_PATH = resolve(process.cwd(), "firebase-service-account.json");

type ServiceAccountJson = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function loadCredentials(): ServiceAccountJson {
  if (existsSync(LOCAL_KEY_PATH)) {
    const raw = readFileSync(LOCAL_KEY_PATH, "utf8");
    return JSON.parse(raw) as ServiceAccountJson;
  }
  const env = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!env || env.trim().length === 0) {
    throw new Error(
      "Firebase credentials missing: neither firebase-service-account.json " +
        "(local) nor FIREBASE_SERVICE_ACCOUNT_JSON (env) is set.",
    );
  }
  return JSON.parse(env) as ServiceAccountJson;
}

function getApp(): admin.app.App {
  if (admin.apps.length > 0 && admin.apps[0]) return admin.apps[0];
  const creds = loadCredentials();
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: creds.project_id,
      clientEmail: creds.client_email,
      privateKey: creds.private_key,
    }),
  });
}

export function firebaseAuth() {
  return getApp().auth();
}

export function firestore() {
  return getApp().firestore();
}

export function firebaseProjectId(): string {
  return loadCredentials().project_id;
}
