// Staff / test-account filter for the registered-user cohort. Used
// by the Cities → Users sub-tab at READ time, not at sync time —
// mdapi_users stores everything unfiltered so the blocklist can
// evolve without a re-sync.
//
// The probe (Phase 0.5) found that isFakePlayer=true is set rarely
// even for obvious staff accounts (e.g. vitaly.i.ushakov+admin@gmail.com,
// leonardo.ribeiro@scrumlaunch.com, iryna.schoka@scrumlaunch.com all
// have isFakePlayer=false). Email-pattern filtering is the practical
// signal until MatchDay starts setting isFakePlayer reliably.

import { INTERNAL_EMAIL_RX } from "./membershipStats";

/* THE STAFF DOMAINS ARE THE SHARED RULE (membershipStats.INTERNAL_EMAIL_RX: @matchday. and
 * @playmatchday.). This file used to carry its own /@(playmatchday|scrumlaunch)\.com$/, which
 * missed every @matchday.com account — 211 of them on 2026-10-14 — so the Users lens counted
 * accounts every other page excludes.
 *
 * TWO EXTRAS STAY, ON TOP OF THE SHARED RULE, and are not part of it: the agency domain and the
 * +admin/+city/+test local parts. They caught 10 accounts on 2026-10-14, none holding a
 * subscription, so they cannot move a member count anywhere — they only keep known staff out of
 * the registered-user cohort here. */
const EXTRA_INTERNAL_DOMAIN_RX = /@scrumlaunch\.com$/i;
const INTERNAL_LOCAL_RX = /\+(admin|city|test)@/i;

/**
 * Returns true if the given user looks like internal staff or a test
 * account that should be excluded from registered-user metrics on the
 * Cities → Users sub-tab.
 *
 * Cohort rules (any one triggers internal):
 *   - isFakePlayer === true (the API's own test-account flag)
 *   - email is null/empty (incomplete records — exclude defensively)
 *   - email matches INTERNAL_EMAIL_RX (@matchday. / @playmatchday.), or is @scrumlaunch.com
 *   - email local-part contains "+admin@", "+city@", or "+test@"
 */
export function isInternalUser(
  email: string | null | undefined,
  isFakePlayer: boolean,
): boolean {
  if (isFakePlayer) return true;
  if (!email) return true;
  const trimmed = email.trim();
  if (!trimmed) return true;
  if (INTERNAL_EMAIL_RX.test(trimmed)) return true;
  if (EXTRA_INTERNAL_DOMAIN_RX.test(trimmed)) return true;
  if (INTERNAL_LOCAL_RX.test(trimmed)) return true;
  return false;
}
