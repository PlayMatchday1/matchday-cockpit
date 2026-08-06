// TEMPORARY diagnostic — verify the Google Calendar domain-wide-delegation grant
// actually works end to end (there is NO calendar integration in the app yet; this
// only tests the Google-side authorization). Uses GOOGLE_SERVICE_ACCOUNT_JSON to
// mint a DELEGATED token for the calling user and lists this week's events. The
// private key / access token are never logged or returned. Delete with the route.

import "server-only";
import { JWT } from "google-auth-library";

const DELEGATION_CLIENT_ID = "117127943311695943830";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const domainOf = (email: string) => (email.includes("@") ? email.split("@")[1] : null);

export type CalProbe = {
  saConfigured: boolean;
  saParsed: boolean;
  saClientEmailDomain: string | null; // domain only (safe)
  saClientId: string | null; // the SA's OAuth client id — compare to the delegation client id
  clientIdMatchesDelegation: boolean; // === the id authorized in Admin console
  scopeRequested: string;
  impersonatedDomain: string | null; // domain of the calling user (never the full email)
  tokenObtained: boolean; // did the delegation token exchange succeed?
  tokenError: string | null; // verbatim exchange error (e.g. "unauthorized_client") — no key
  httpStatus: number; // Calendar events.list status
  eventCount: number | null;
  httpError: string | null; // verbatim Calendar error body (<=400 chars)
  timeMin: string;
  timeMax: string;
};

// Monday 00:00 UTC of the current week → +7 days.
function weekBounds(now: Date): { timeMin: string; timeMax: string } {
  const min = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  min.setUTCDate(min.getUTCDate() - ((min.getUTCDay() + 6) % 7));
  const max = new Date(min);
  max.setUTCDate(max.getUTCDate() + 7);
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

export async function probeCalendar(subjectEmail: string): Promise<CalProbe> {
  const { timeMin, timeMax } = weekBounds(new Date());
  const base: CalProbe = {
    saConfigured: false, saParsed: false, saClientEmailDomain: null, saClientId: null,
    clientIdMatchesDelegation: false, scopeRequested: SCOPE, impersonatedDomain: domainOf(subjectEmail),
    tokenObtained: false, tokenError: null, httpStatus: 0, eventCount: null, httpError: null, timeMin, timeMax,
  };

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return base;
  base.saConfigured = true;

  let sa: { client_email?: string; private_key?: string; client_id?: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    try {
      sa = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); // tolerate base64-wrapped JSON
    } catch {
      base.tokenError = "GOOGLE_SERVICE_ACCOUNT_JSON did not parse as JSON (raw or base64).";
      return base;
    }
  }
  base.saParsed = true;
  base.saClientEmailDomain = sa.client_email ? domainOf(sa.client_email) : null;
  base.saClientId = sa.client_id ?? null;
  base.clientIdMatchesDelegation = String(sa.client_id ?? "") === DELEGATION_CLIENT_ID;
  if (!sa.client_email || !sa.private_key) {
    base.tokenError = "Service-account JSON is missing client_email / private_key.";
    return base;
  }

  // Domain-wide delegation: signing as the SA with `subject` performs the
  // impersonation exchange. If delegation isn't authorized for this scope, the
  // exchange fails here (e.g. "unauthorized_client").
  let token: string | null | undefined;
  try {
    const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE], subject: subjectEmail });
    token = (await jwt.getAccessToken()).token;
  } catch (e) {
    base.tokenError = e instanceof Error ? e.message : String(e);
    return base;
  }
  if (!token) {
    base.tokenError = "No access token returned from the delegation exchange.";
    return base;
  }
  base.tokenObtained = true;

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&maxResults=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  base.httpStatus = res.status;
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as { items?: unknown[] };
    base.eventCount = (j.items ?? []).length;
  } else {
    base.httpError = (await res.text().catch(() => "")).slice(0, 400); // Apple/Google error JSON, verbatim
  }
  return base;
}
