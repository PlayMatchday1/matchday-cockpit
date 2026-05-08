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

const INTERNAL_DOMAIN_RX = /@(playmatchday|scrumlaunch)\.com$/i;
const INTERNAL_LOCAL_RX = /\+(admin|city|test)@/i;

/**
 * Returns true if the given user looks like internal staff or a test
 * account that should be excluded from registered-user metrics on the
 * Cities → Users sub-tab.
 *
 * Cohort rules (any one triggers internal):
 *   - isFakePlayer === true (the API's own test-account flag)
 *   - email is null/empty (incomplete records — exclude defensively)
 *   - email domain is @playmatchday.com or @scrumlaunch.com
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
  if (INTERNAL_DOMAIN_RX.test(trimmed)) return true;
  if (INTERNAL_LOCAL_RX.test(trimmed)) return true;
  return false;
}
