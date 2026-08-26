// POST /api/firebase-token — mints a Firebase custom token for the
// authenticated Cockpit admin so the browser can sign into Firebase
// directly and open Firestore listeners.
//
// Why a custom token (vs proxying every Firestore read through
// Vercel): real-time listeners are what makes the Match Chats UI
// feel native. Vercel functions are short-lived; long-lived listener
// fan-out belongs on the client.
//
// Auth: dual-mode bearer via src/lib/crmAuth (session JWT with
// app_users.is_admin=true, OR CRON_SECRET). The cron path is
// vestigial here — no scheduled job mints these — but kept for
// consistency with the rest of the CRM stack.
//
// Token claims (audited later by Firestore security rules, once we
// tighten them per the Phase 3 note):
//   uid                 app_users.id (uuid)
//   operator_user_id    same as uid; redundant but explicit for
//                       rules that filter by claim
//   cockpit_operator    true
//
// Firebase web config (apiKey / authDomain / appId) is returned in
// the same response so the client has everything it needs in one
// round-trip. These are NEXT_PUBLIC env vars — public client config
// values, not secrets. projectId comes from the service-account JSON.

import { authenticateCrm } from "@/lib/crmAuth";
import {
  firebaseAuth,
  firebaseProjectId,
} from "@/lib/firebaseAdmin";
import type {
  FirebaseTokenResponse,
  FirebaseWebConfig,
} from "@/lib/matchChats";

export const runtime = "nodejs";
export const maxDuration = 10;

function readFirebaseWebConfig(): FirebaseWebConfig | { error: string } {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !appId) {
    return {
      error:
        "Firebase web config env vars missing: " +
        "NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_APP_ID " +
        "must be set in Vercel for the client SDK to initialize.",
    };
  }
  const projectId = firebaseProjectId();
  const authDomain =
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
    `${projectId}.firebaseapp.com`;
  return { projectId, apiKey, authDomain, appId };
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { appUserId } = auth;
  if (!appUserId) {
    // CRON_SECRET path: no operator identity to mint against.
    return Response.json(
      { error: "Operator identity required for Firebase token minting" },
      { status: 400 },
    );
  }

  const cfg = readFirebaseWebConfig();
  if ("error" in cfg) {
    console.error("[firebase-token] config error:", cfg.error);
    return Response.json({ error: cfg.error }, { status: 500 });
  }

  // Custom tokens are short-lived (1 hour) by design. Once the
  // client calls signInWithCustomToken successfully, the Firebase
  // Auth session is established and the SDK auto-refreshes ID
  // tokens; we don't need to refresh the custom token itself.
  let token: string;
  try {
    /* THE CONFINED CITY TRAVELS IN THE CLAIMS.
     *
     * This route is now reachable by a confined account — it has to be, or the Match Chats page it
     * is allowed to open cannot render a message. But the token it mints is what the browser uses
     * to open Firestore listeners DIRECTLY, and a listener does not go through /api/match-chats,
     * which is where our city scoping lives.
     *
     * So the scope is stamped into the token. `confined_city` is null for an unconfined operator
     * and the city identifier for a confined one, and Firestore security rules can filter on it.
     *
     * SAY WHAT THIS DOES NOT DO: the rules live in the Firebase console, not this repo, so nothing
     * here can prove they read this claim. Until they do, the boundary on the Firestore layer is
     * the UI showing only what /api/match-chats/active returned — which is a shorter menu, not a
     * boundary. The claim is the half that can be shipped from here; the rule is the half that
     * makes it enforcement. */
    token = await firebaseAuth().createCustomToken(appUserId, {
      cockpit_operator: true,
      operator_user_id: appUserId,
      confined_city: auth.confinedCity ?? null,
    });
  } catch (err) {
    console.error("[firebase-token] mint failed", err);
    return Response.json(
      { error: "Token mint failed" },
      { status: 500 },
    );
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const elapsed = Date.now() - startedAt;
  console.log(
    `[firebase-token] minted for app_user=${appUserId} elapsed=${elapsed}ms`,
  );

  const body: FirebaseTokenResponse = { token, config: cfg, expiresAt };
  return Response.json(body, { status: 200 });
}
