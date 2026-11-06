// APP ACTIVITY — what a player did in the app, from the backend's request log (app_request_log, 0257).
//
// One row per API request the app made. This file turns rows into what Support reads: a plain-word
// title per route, a plain-word reason per error code, background requests folded, grouped by day in
// the player's city time. Shared by the Player Lookup card and the Player Chats panel, so the two
// can never word the same request differently.
//
// WHAT THE LOG CAN AND CANNOT SAY (backend fix/request-logging, core/request-logger/request-log.ts):
//   · `route` is the Fastify route pattern with NO global prefix: versioned routes read /v3/matches/join.
//   · A booking is POST /v2|v3/matches/join with the match id in the BODY, which is never logged. The
//     match comes only from `match_id` (the backend's "matchId", added separately; null until then)
//     or from a :id in the path. A match is NEVER inferred from a neighbouring row.
//   · `errorCode` is null for guard 401s, validation 400s and unmatched-route 404s. Any status >= 400
//     is a failure regardless (Ryan, 2026-11-06).
//   · A failed sign-in has user_id null, so it never appears on a player's timeline.
//
// Client-safe: no server imports.

export type ActivityRow = {
  id: number;
  ts: string;            // true UTC instant (ISO)
  reqId: string;
  method: string;
  path: string;
  route: string | null;
  status: number;
  durationMs: number;
  errorCode: string | null;
  matchId: number | null; // from the log line's matchId; path ids are read separately
  ip?: string | null;     // present for admins only — the route omits it otherwise
};

export type Category = "booking" | "payment" | "account" | "other";

type RouteWords = { title: string; fail?: string; cat: Category; bg?: string; detail?: string };

// ── ROUTE → WORDS. Keyed `${METHOD} ${route}`, from the backend's controllers (survey 2026-11-06).
// `bg` marks a background request and is its short label in the folded row.
const R: Record<string, RouteWords> = {
  // Bookings, cancels, moves
  "POST /v2/matches/join": { title: "Booked a spot", fail: "Booking failed", cat: "booking" },
  "POST /v3/matches/join": { title: "Booked a spot", fail: "Booking failed", cat: "booking" },
  "POST /matches/join-additional-spots": { title: "Added extra spots", fail: "Couldn't add extra spots", cat: "booking" },
  "POST /v3/matches/join-additional-spots": { title: "Added extra spots", fail: "Couldn't add extra spots", cat: "booking" },
  "POST /v2/matches/join-price": { title: "Checked the price to join", fail: "Couldn't get the price to join", cat: "booking" },
  "POST /matches/:id/validate-promocode": { title: "Tried a promo code", fail: "Promo code not accepted", cat: "booking" },
  "POST /matches/:matchId/teams/:teamNumber/password": { title: "Entered a team password", fail: "Team password not accepted", cat: "booking" },
  "PATCH /matches/:id/cancel-reservation": { title: "Cancelled a reserved spot", fail: "Couldn't cancel reserved spot", cat: "booking" },
  "DELETE /matches/:id/leave": { title: "Cancelled spot", fail: "Couldn't cancel spot", cat: "booking" },
  "POST /matches/:id/review": { title: "Reviewed a match", fail: "Couldn't review a match", cat: "booking" },
  "PUT /admin/user-matches": { title: "Changed their spot in a match", fail: "Couldn't change their spot in a match", cat: "booking" },
  "POST /special-events/teams/:teamId/join": { title: "Joined an event team", fail: "Couldn't join an event team", cat: "booking" },
  "DELETE /special-events/teams/:teamId/leave": { title: "Left an event team", fail: "Couldn't leave an event team", cat: "booking" },
  "POST /special-events/teams/:teamId/password": { title: "Entered an event team password", fail: "Event team password not accepted", cat: "booking" },
  "POST /special-events/divisions/:divisionId/teams": { title: "Created an event team", fail: "Couldn't create an event team", cat: "booking" },
  "PUT /special-events/teams/:teamId": { title: "Updated an event team", fail: "Couldn't update an event team", cat: "booking" },

  // Payments and membership
  "POST /subscriptions": { title: "Started a membership", fail: "Membership sign-up failed", cat: "payment" },
  "DELETE /subscriptions/:userSubscriptionId": { title: "Cancelled membership", fail: "Couldn't cancel membership", cat: "payment" },
  "PATCH /subscriptions/:userSubscriptionId/payment-methods": { title: "Changed membership card", fail: "Couldn't change membership card", cat: "payment" },
  "GET /subscriptions": { title: "Loaded memberships", cat: "payment", bg: "loading screens" },
  "GET /player/subscriptions": { title: "Loaded their membership", cat: "payment", bg: "loading screens" },
  "POST /v2/player/payment-methods": { title: "Saved a card", fail: "Couldn't save a card", cat: "payment" },
  "GET /player/payment-methods": { title: "Loaded saved cards", cat: "payment", bg: "loading screens" },
  "DELETE /player/payment-methods/:id": { title: "Removed a card", fail: "Couldn't remove a card", cat: "payment" },
  "GET /stripe": { title: "Loaded payment setup", cat: "payment", bg: "loading screens" },
  "GET /strikes": { title: "Loaded strikes", cat: "payment", bg: "loading screens" },
  "GET /strikes/cities/:cityAbbr": { title: "Loaded strike fee", cat: "payment", bg: "loading screens" },
  "POST /strikes/payment": { title: "Paid a strike fee", fail: "Strike fee payment failed", cat: "payment" },
  "POST /special-events/divisions/:divisionId/payments": { title: "Paid for an event", fail: "Event payment failed", cat: "payment" },
  "GET /special-events/captain-divisions/:captainDivisionId/payments": { title: "Loaded event payments", cat: "payment", bg: "loading screens" },

  // Sign-in and account
  "POST /auth/signup": { title: "Signed up", fail: "Sign-up failed", cat: "account" },
  "POST /v2/auth/signup": { title: "Signed up", fail: "Sign-up failed", cat: "account" },
  "POST /auth/apple": { title: "Signed in", detail: "With Apple", fail: "Apple sign-in failed", cat: "account" },
  "POST /auth/google": { title: "Signed in", detail: "With Google", fail: "Google sign-in failed", cat: "account" },
  "POST /auth/facebook": { title: "Signed in", detail: "With Facebook", fail: "Facebook sign-in failed", cat: "account" },
  "POST /auth/email-verification": { title: "Verified their email", fail: "Email code not accepted", cat: "account" },
  "POST /auth/resend-email-verification": { title: "Asked for a new email code", fail: "Couldn't send a new email code", cat: "account" },
  "POST /v2/auth/signup/complete": { title: "Finished sign-up", fail: "Couldn't finish sign-up", cat: "account" },
  "POST /v3/auth/signup/complete": { title: "Finished sign-up", fail: "Couldn't finish sign-up", cat: "account" },
  "POST /auth/verifications/phone-number": { title: "Asked for a phone code", fail: "Couldn't send a phone code", cat: "account" },
  "POST /v2/auth/verifications/phone-number": { title: "Asked for a phone code", fail: "Couldn't send a phone code", cat: "account" },
  "POST /auth/verifications/phone-number/code": { title: "Verified their phone", fail: "Phone code not accepted", cat: "account" },
  "POST /v2/auth/verifications/phone-number/code": { title: "Verified their phone", fail: "Phone code not accepted", cat: "account" },
  "POST /auth/signin": { title: "Signed in", detail: "With email", fail: "Sign-in failed", cat: "account" },
  "POST /v2/auth/signin": { title: "Signed in", detail: "With email", fail: "Sign-in failed", cat: "account" },
  "POST /auth/signin/admin": { title: "Signed in to the admin app", fail: "Admin sign-in failed", cat: "account" },
  "POST /auth/forgot-password": { title: "Asked for a password reset code", detail: "Sent to their email", fail: "Couldn't send a password reset code", cat: "account" },
  "POST /v2/auth/forgot-password": { title: "Asked for a password reset code", detail: "Sent to their email", fail: "Couldn't send a password reset code", cat: "account" },
  "POST /auth/reset-password": { title: "Reset their password", fail: "Password reset failed", cat: "account" },
  "POST /v2/auth/reset-password": { title: "Reset their password", fail: "Password reset failed", cat: "account" },
  "POST /auth/refresh": { title: "Refreshed sign-in", fail: "Sign-in refresh failed", cat: "account", bg: "refreshing sign-in" },
  "GET /player/profile": { title: "Loaded their profile", cat: "account", bg: "loading screens" },
  "PUT /player/profile": { title: "Updated profile", detail: "Profile details changed. What changed isn't recorded.", fail: "Couldn't update profile", cat: "account" },
  "PATCH /player/profile/update-password": { title: "Changed their password", fail: "Couldn't change password", cat: "account" },
  "POST /player/logout": { title: "Signed out", fail: "Sign-out failed", cat: "account" },
  "DELETE /player/profile/avatar": { title: "Removed their photo", fail: "Couldn't remove photo", cat: "account" },
  "DELETE /player/profile/phone": { title: "Removed their phone number", fail: "Couldn't remove phone number", cat: "account" },
  "DELETE /player/profile/:id": { title: "Deleted their account", fail: "Couldn't delete account", cat: "account" },
  "POST /user-devices": { title: "Registered for notifications", cat: "account", bg: "device checks" },
  "POST /v2/device-integrity": { title: "Device check", cat: "account", bg: "device checks" },

  // Browsing and everything else
  "GET /matches/:id": { title: "Opened a match", cat: "other" },
  "GET /matches": { title: "Loaded matches", cat: "other", bg: "loading screens" },
  "GET /matches/my-matches": { title: "Loaded their matches", cat: "other", bg: "loading screens" },
  "GET /matches/matches-for-review": { title: "Loaded matches to review", cat: "other", bg: "loading screens" },
  "GET /events": { title: "Loaded events", cat: "other", bg: "loading screens" },
  "GET /special-events/events": { title: "Loaded special events", cat: "other", bg: "loading screens" },
  "GET /special-events/events/:eventId": { title: "Opened a special event", cat: "other" },
  "GET /special-events/events/:eventId/divisions": { title: "Loaded event divisions", cat: "other", bg: "loading screens" },
  "GET /special-events/divisions/:divisionId/teams": { title: "Loaded event teams", cat: "other", bg: "loading screens" },
  "GET /special-events/divisions/:divisionId/matches": { title: "Loaded event matches", cat: "other", bg: "loading screens" },
  "GET /fields": { title: "Loaded fields", cat: "other", bg: "loading screens" },
  "GET /fields/:id": { title: "Opened a field", cat: "other" },
  "GET /cities": { title: "Loaded cities", cat: "other", bg: "loading screens" },
  "GET /cities/nearby": { title: "Looked up nearby cities", cat: "other", bg: "loading screens" },
  "GET /cities/:id": { title: "Loaded their city", cat: "other", bg: "loading screens" },
  "POST /cities/nearby-notify": { title: "Asked to hear when MatchDay comes nearby", fail: "Couldn't sign up for city news", cat: "other" },
  "GET /states": { title: "Loaded states", cat: "other", bg: "loading screens" },
  "GET /time-zones": { title: "Loaded time zones", cat: "other", bg: "loading screens" },
  "GET /app-config": { title: "Loaded app settings", cat: "other", bg: "loading screens" },
  "GET /notifications": { title: "Loaded notifications", cat: "other", bg: "loading screens" },
  "PATCH /notifications/:id": { title: "Read a notification", cat: "other", bg: "reading notifications" },
  "GET /offers/popup": { title: "Checked for an offer", cat: "other", bg: "offer checks" },
  "POST /offers/popup/preview/:previewId/seen": { title: "Saw an offer preview", cat: "other", bg: "offer checks" },
  "POST /offers/popup/:grantId/events": { title: "Responded to an offer", cat: "other" },
  "POST /offers/pushes/:pushId/opened": { title: "Opened a push notification", cat: "other" },
  "POST /chats/matches/:matchId/notifications": { title: "Changed match chat notifications", cat: "other" },
  "PUT /chats/matches/:matchId/notifications": { title: "Changed match chat notifications", cat: "other" },
  "POST /chats/special-events/:eventId/notifications": { title: "Changed event chat notifications", cat: "other" },
  "PUT /chats/special-events/:eventId/notifications": { title: "Changed event chat notifications", cat: "other" },
  "GET /goals/my-goals": { title: "Loaded their goals", cat: "other", bg: "loading screens" },
  "POST /files": { title: "Uploaded a file", fail: "Upload failed", cat: "other" },
};
for (const k of [
  "/leaderboard/name", "/leaderboard/current/matches", "/leaderboard/current/goals", "/leaderboard/matches",
  "/leaderboard/matches/global", "/leaderboard/goals", "/leaderboard/goals/global", "/leaderboard/my-stats",
  "/leaderboard/my-stats/global",
]) R[`GET ${k}`] = { title: "Loaded the leaderboard", cat: "other", bg: "loading screens" };

// A repeat of GET /matches/:id for the SAME match within this long of the previous one is the app
// rechecking it (it polls every 30 s while a reserved spot is unpaid, MatchDetails.tsx:156), not the
// player opening it again.
const RECHECK_MS = 120_000;

// ── ERROR CODE → WORDS. Only codes that exist in the backend (survey 2026-11-06). An unmapped code
// shows raw with GENERIC_CODE.
export const ERROR_WORDS: Record<string, string> = {
  NO_SPOTS_LEFT: "The match was full, so no spot was booked.",
  MATCH_ALREADY_STARTED: "The match had already started, so the app wouldn't change the spot.",
  MATCH_ALREADY_PASSED: "The match was already over.",
  MATCH_IS_CANCELLED: "The match is cancelled.",
  MATCH_IS_NOT_STARTED: "The match hadn't started yet.",
  MATCH_IS_NOT_ENDED: "The match hadn't ended yet.",
  FORBIDDEN_MATCH: "The app wouldn't let this player into that match.",
  FORBIDDEN_MATCH_START_DATE: "The match's start time didn't allow this.",
  USER_ALREADY_JOINED_MATCH: "The player was already in this match.",
  USER_IS_NOT_JOINED_MATCH: "The player wasn't in this match.",
  USER_NOT_JOINED_MATCH: "The player wasn't in this match.",
  PLAYER_NUMBER_ALREADY_TAKEN: "That player number was already taken.",
  PASSWORD_FOR_THIS_TEAM_IS_INCORRECT: "The team password was wrong.",
  TEAM_PASSWORD_INVALID: "The team password was wrong.",
  TEAM_IS_NOT_LOCKED: "That team isn't password-locked.",
  TEAM_HAS_PLAYERS: "That team already has players.",
  TEAM_NOT_FOUND: "That team doesn't exist.",
  MEMBERSHIP_IS_SUSPENDED: "The player's membership is suspended.",
  GUEST_COUNT_EXCEEDED: "Too many guests on one booking.",
  NOT_ENOUGH_FREE_SPOTS_FOR_MIGRATION: "There weren't enough free spots to move the players.",
  REVIEW_ALREADY_EXISTS: "The player had already reviewed this match.",
  STAR_RATING_OR_SKIP_RATING_REQUIRED: "The review was sent without a rating.",
  STRIPE_REFUND_ERROR: "Stripe refused the refund.",
  CITY_STRIPE_ACCOUNT_REQUIRED: "This city has no Stripe account set up for match payments.",
  PRICE_CHANGED: "The price changed after the player saw it. They need to check the new price and book again.",
  OFFER_PRICE_CHANGED: "The offer price changed after the player saw it.",
  MATCH_RESERVATION_NOT_CANCELLED: "The server couldn't cancel the reservation.",
  NOT_FOUND_MATCH_RESERVATION: "There was no reservation to cancel.",
  NOT_FOUND_MULTIPLE_MATCHES: "One or more of the matches wasn't found.",
  MATCH_IMMUTABLE_PROPERTIES: "Those match details can't be changed.",
  INVALID_PROMOCODE: "The promo code isn't valid.",
  USER_EXCEEDED_NUMBER_OF_PROMOCODE_USES: "The player has used this promo code as many times as allowed.",
  NOT_FOUND_PROMOCODE: "That promo code doesn't exist.",
  PROMOCODE_IS_DELETED: "That promo code was deleted.",
  PROMOCODE_START_DATE_PASSED: "That promo code's dates don't allow it now.",
  FORBIDDEN_DEADLINE_FOR_SIGNUP_HAS_PASSED: "The sign-up deadline for this event has passed.",
  FORBIDDEN_USER_ALREADY_JOINED_TEAM: "The player is already on a team in this event.",
  FORBIDDEN_NO_SPOT_LEFT_IN_TEAM: "That team is full.",
  FORBIDDEN_CANNOT_CANCEL_TEAM_BEFORE_7_DAYS: "Event teams can't be cancelled inside 7 days.",
  FORBIDDEN_CAPTAIN_ALREADY_PAID: "The captain has already paid.",
  FORBIDDEN_CAPTAIN_DIVISION_NOT_PAID: "The captain hasn't paid for this division yet.",
  FORBIDDEN_TEAM_PASSWORD_REQUIRED: "This team needs a password.",
  USER_ALREADY_SUBSCRIBED: "The player already has a membership.",
  FAILED_TO_SUBSCRIBE_TO_SUBSCRIPTION: "The membership couldn't be started.",
  FAILED_TO_CREATE_SUBSCRIPTION: "The membership couldn't be created.",
  SUBSCRIPTION_NOT_FOUND: "That membership wasn't found.",
  PAYMENT_METHOD_CAN_NOT_BE_DELETED: "That card can't be removed.",
  PAYMENT_METHOD_INVALID: "The card wasn't accepted as a payment method.",
  PAYMENT_METHOD_NOT_SAVED: "The card couldn't be saved.",
  PAYMENT_METHOD_NOT_DELETED: "The card couldn't be removed.",
  PAYMENT_METHOD_NOT_FOUND: "That card wasn't found.",
  NOT_FOUND_STRIPE_ACCOUNT: "No Stripe account was found for this.",
  EMAIL_ALREADY_VERIFIED: "The email was already verified.",
  EMAIL_IS_NOT_TARGET_FOR_VERIFICATION: "That email isn't the one being verified.",
  EMAIL_IS_NOT_VERIFIED: "The player's email isn't verified yet.",
  PHONE_IS_NOT_VERIFIED: "The player's phone isn't verified yet.",
  PHONE_ALREADY_VERIFIED: "The phone was already verified.",
  EMAIL_VERIFICATION_CODE_EXPIRED: "The email code had expired.",
  INCORRECT_EMAIL_VERIFICATION_CODE: "The email code was wrong.",
  SIGN_UP_IS_COMPLETED: "Sign-up was already finished.",
  USER_ALREADY_EXISTS: "An account with that email already exists.",
  USER_IS_NOT_ADMIN_OR_CITY_MANAGER: "This account isn't an admin or city manager.",
  INCORRECT_EMAIL_OR_PASSWORD: "The email or password was wrong.",
  REFRESH_TOKEN_IS_NOT_VALID: "The saved sign-in had expired, so the player has to sign in again.",
  OAUTH_INVALID_TOKEN: "Apple, Google or Facebook didn't confirm the sign-in.",
  INVALID_PHONE_NUMBER: "The phone number isn't valid.",
  INVALID_PHONE_NUMBER_OR_CODE: "The phone number or code was wrong.",
  USER_ALREADY_EXISTS_WITH_THIS_PHONE_NUMBER: "Another account already uses that phone number.",
  USER_IS_BANNED: "The player is banned.",
  USER_NOT_FOUND_BY_EMAIL: "No account has that email.",
  USER_NOT_FOUND_BY_EMAIL_OR_PHONE_NUMBER: "No account has that email or phone number.",
  USER_NOT_FOUND: "The account wasn't found.",
  INCORRECT_CURRENT_PASSWORD: "The current password was wrong.",
  PASSWORDS_DO_NOT_MATCH: "The two passwords didn't match.",
  FORBIDDEN_USER_TO_DELETE: "This account can't be deleted.",
  INVALID_ZIP_CODE: "The ZIP code isn't valid.",
  INVALID_COORDINATES: "The location wasn't valid.",
  LOCATION_REQUIRED: "The app didn't send a location.",
  PREFERABLE_CITY_REQUIRED: "The player hasn't picked a city.",
  FORBIDDEN: "The server refused this.",
  NOT_FOUND: "What the app asked for wasn't found.",
  PRECONDITION_RESOURCE_FAILED: "The server refused this because something had changed.",
  INTERNAL_SERVER_ERROR: "The server hit an error.",
};
const GENERIC_CODE = "The server refused this with a code Clubhouse doesn't have words for yet.";

export function failureReason(r: Pick<ActivityRow, "status" | "errorCode" | "route">): string {
  if (r.errorCode) return ERROR_WORDS[r.errorCode] ?? GENERIC_CODE;
  if (r.status === 401) return "The app's sign-in wasn't accepted. Usually an expired session, which the app then refreshes.";
  if (r.status === 404 && r.route == null) return "The app asked for an address the server doesn't have.";
  if (r.status === 404) return "What the app asked for wasn't found.";
  if (r.status === 400) return "The server rejected what the app sent, with no error code.";
  if (r.status >= 500) return "The server hit an error.";
  return "The server refused this, with no error code.";
}

// ── MATCH ID IN THE PATH. Aligns the route pattern with the path, segment by segment.
const MATCH_PARAM_PREFIXES = ["/matches/", "/chats/matches/"];
export function matchIdOf(r: Pick<ActivityRow, "route" | "path" | "matchId">): number | null {
  if (r.matchId != null) return r.matchId;
  if (!r.route || !MATCH_PARAM_PREFIXES.some((p) => r.route!.startsWith(p))) return null;
  const rs = r.route.split("/"), ps = r.path.split("/");
  if (rs.length !== ps.length) return null;
  for (let i = 0; i < rs.length; i++) {
    if ((rs[i] === ":id" || rs[i] === ":matchId") && /^\d+$/.test(ps[i])) return Number(ps[i]);
  }
  return null;
}

// ── ANNOTATE
export type Item = ActivityRow & {
  title: string;
  detail: string | null;
  cat: Category;
  failed: boolean;
  background: string | null; // the folded-row label, or null for an action
  reason: string | null;      // plain words, failures only
  known: boolean;             // false = the route map has no entry; the title is the raw pattern
  matchRef: number | null;
};

export function annotate(rows: ActivityRow[]): Item[] {
  // Ascending pass for the recheck rule, then returned newest first.
  const asc = [...rows].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
  const lastOpen = new Map<string, number>();
  const out: Item[] = asc.map((r) => {
    const key = `${r.method} ${r.route ?? ""}`;
    const w = r.route ? R[key] : undefined;
    const failed = r.status >= 400;
    let bg = w?.bg ?? null;
    if (key === "GET /matches/:id") {
      const t = Date.parse(r.ts), prev = lastOpen.get(r.path);
      if (prev != null && t - prev <= RECHECK_MS) bg = "rechecking a match";
      lastOpen.set(r.path, t);
    }
    return {
      ...r,
      title: w ? (failed && w.fail ? w.fail : w.title) : `${r.method} ${r.route ?? r.path}`,
      detail: w?.detail ?? null,
      cat: w?.cat ?? "other",
      failed,
      background: failed ? null : bg, // a failure is never folded away
      reason: failed ? failureReason(r) : null,
      known: !!w,
      matchRef: matchIdOf(r),
    };
  });
  return out.reverse();
}

// ── SUMMARY AND FILTERS
export type Filter = "all" | "failures" | Exclude<Category, "other">;
export const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "failures", label: "Failures" },
  { key: "booking", label: "Bookings & cancels" },
  { key: "payment", label: "Payments & membership" },
  { key: "account", label: "Sign-in & account" },
];

export function isAction(i: Item): boolean { return i.background == null; }

export function passes(i: Item, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "failures") return i.failed;
  return isAction(i) && i.cat === f;
}

export function summarize(items: Item[]) {
  const actions = items.filter(isAction);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, f.key === "all" ? actions.length : items.filter((i) => passes(i, f.key)).length])) as Record<Filter, number>;
  return {
    lastSeen: items[0]?.ts ?? null,
    actions: actions.length,
    background: items.length - actions.length,
    failures: counts.failures,
    counts,
    latestFailure: items.find((i) => i.failed) ?? null,
  };
}

export const RECENT_FAILURE_MS = 7 * 86_400_000;
export function recentFailure(items: Item[], now = Date.now()): Item | null {
  const f = items.find((i) => i.failed);
  return f && now - Date.parse(f.ts) <= RECENT_FAILURE_MS ? f : null;
}

// ── DAYS AND FOLDING (in the player's city zone)
export type Line = { kind: "item"; item: Item } | { kind: "bg"; key: string; items: Item[]; labels: string[] };
export type Day = { ymd: string; label: string; lines: Line[] };

export function ymdIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
export function timeIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function dayLabel(ymd: string, tz: string, now: Date): string {
  const today = ymdIn(now.toISOString(), tz);
  const yest = ymdIn(new Date(now.getTime() - 86_400_000).toISOString(), tz);
  // Noon UTC on that calendar date formats to the same date in every zone we serve.
  const d = new Date(`${ymd}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d);
  const md = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
  if (ymd === today) return `Today · ${wd}, ${md}`;
  if (ymd === yest) return `Yesterday · ${wd}, ${md}`;
  return `${wd}, ${md}`;
}
// Short relative stamp for the compact panel: "7:43 PM", "Yest. 9:18 PM", "Tue 12:10 PM", "Oct 2 3:00 PM".
export function shortStamp(iso: string, tz: string, now = new Date()): string {
  const ymd = ymdIn(iso, tz), t = timeIn(iso, tz);
  if (ymd === ymdIn(now.toISOString(), tz)) return t;
  if (ymd === ymdIn(new Date(now.getTime() - 86_400_000).toISOString(), tz)) return `Yest. ${t}`;
  const d = new Date(`${ymd}T12:00:00Z`);
  const ageDays = (now.getTime() - Date.parse(iso)) / 86_400_000;
  const head = ageDays < 6
    ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d)
    : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d);
  return `${head} ${t}`;
}

export function groupDays(items: Item[], tz: string, filter: Filter, now = new Date()): Day[] {
  const days: Day[] = [];
  for (const it of items) {
    if (filter !== "all" && !passes(it, filter)) continue;
    const ymd = ymdIn(it.ts, tz);
    let day = days[days.length - 1];
    if (!day || day.ymd !== ymd) { day = { ymd, label: dayLabel(ymd, tz, now), lines: [] }; days.push(day); }
    if (filter === "all" && it.background != null) {
      const last = day.lines[day.lines.length - 1];
      if (last && last.kind === "bg") {
        last.items.push(it);
        if (!last.labels.includes(it.background)) last.labels.push(it.background);
        continue;
      }
      day.lines.push({ kind: "bg", key: `bg-${it.id}`, items: [it], labels: [it.background] });
      continue;
    }
    day.lines.push({ kind: "item", item: it });
  }
  return days;
}

// ── MATCHES, from our own data. Wall-clock start (see CLAUDE.md: never through new Date()).
export type MatchInfo = { field: string | null; start: string | null; city: string | null };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// WALL-CLOCK MODEL: `start` is the match's LOCAL wall clock despite any Z/+00:00 suffix. Read off
// the string; the weekday comes from the calendar date alone.
export function matchLine(m: MatchInfo | undefined, id: number): string {
  if (!m) return `Match #${id}`;
  const x = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(m.start ?? "");
  let when = "";
  if (x) {
    const [, y, mo, d, hh, mi] = x;
    const wd = WEEKDAYS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
    const h = +hh, h12 = h % 12 === 0 ? 12 : h % 12;
    when = `${wd}, ${MONTHS[+mo - 1]} ${+d} · ${h12}:${mi} ${h >= 12 ? "PM" : "AM"}`;
  }
  return [m.field ?? `Match #${id}`, when].filter(Boolean).join(" · ");
}

export function engineeringText(i: Item, playerId: number, env: string): string {
  return [
    `Player ${playerId} (${env})`,
    `${i.ts}  ${i.method} ${i.path}`,
    `route: ${i.route ?? "(no route matched)"}`,
    `status: ${i.status}  code: ${i.errorCode ?? "-"}  duration: ${i.durationMs} ms`,
    `request id: ${i.reqId}`,
    i.matchRef != null ? `match: ${i.matchRef}` : null,
  ].filter(Boolean).join("\n");
}

export const ROUTE_WORDS = R; // read by the drift check against the backend's controllers
